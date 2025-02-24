import {
  IParserAmbiguousAlternativesDefinitionError,
  IParserDuplicatesDefinitionError,
  IParserEmptyAlternativeDefinitionError,
  ParserDefinitionErrorType
} from "../parser/parser"
import { getProductionDslName, isOptionalProd } from "@chevrotain/gast"
import {
  Alternative,
  containsPath,
  getLookaheadPathsForOptionalProd,
  getLookaheadPathsForOr,
  getProdType,
  isStrictPrefixOfPath
} from "./lookahead"
import { nextPossibleTokensAfter } from "./interpreter"
import {
  Alternation,
  Alternative as AlternativeGAST,
  NonTerminal,
  Option,
  Repetition,
  RepetitionMandatory,
  RepetitionMandatoryWithSeparator,
  RepetitionWithSeparator,
  Terminal
} from "@chevrotain/gast"
import { GAstVisitor } from "@chevrotain/gast"
import {
  ILookaheadStrategy,
  IProduction,
  IProductionWithOccurrence,
  TokenType,
  Rule
} from "@chevrotain/types"
import {
  IGrammarValidatorErrorMessageProvider,
  IParserDefinitionError
} from "./types"
import { tokenStructuredMatcher } from "../../scan/tokens"

// ES2019 Array.prototype.flatMap
function flatMap<U, R>(arr: U[], callback: (x: U, idx: number) => R[]): R[] {
  return Array.prototype.concat.apply([], arr.map(callback))
}

export function validateLookahead(options: {
  lookaheadStrategy: ILookaheadStrategy
  rules: Rule[]
  tokenTypes: TokenType[]
  grammarName: string
}): IParserDefinitionError[] {
  const lookaheadValidationErrorMessages = options.lookaheadStrategy.validate({
    rules: options.rules,
    tokenTypes: options.tokenTypes,
    grammarName: options.grammarName
  })
  return lookaheadValidationErrorMessages.map((errorMessage) => ({
    type: ParserDefinitionErrorType.CUSTOM_LOOKAHEAD_VALIDATION,
    ...errorMessage
  }))
}

export function validateGrammar(
  topLevels: Rule[],
  tokenTypes: TokenType[],
  errMsgProvider: IGrammarValidatorErrorMessageProvider,
  grammarName: string
): IParserDefinitionError[] {
  const duplicateErrors = ([] as IParserDefinitionError[]).concat(
    ...topLevels.map((currTopLevel) =>
      validateDuplicateProductions(currTopLevel, errMsgProvider)
    )
  )

  const termsNamespaceConflictErrors = checkTerminalAndNoneTerminalsNameSpace(
    topLevels,
    tokenTypes,
    errMsgProvider
  )

  const tooManyAltsErrors = flatMap(topLevels, (curRule) =>
    validateTooManyAlts(curRule, errMsgProvider)
  )

  const duplicateRulesError = flatMap(topLevels, (curRule) =>
    validateRuleDoesNotAlreadyExist(
      curRule,
      topLevels,
      grammarName,
      errMsgProvider
    )
  )

  return duplicateErrors.concat(
    termsNamespaceConflictErrors,
    tooManyAltsErrors,
    duplicateRulesError
  )
}

function validateDuplicateProductions(
  topLevelRule: Rule,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserDuplicatesDefinitionError[] {
  const collectorVisitor = new OccurrenceValidationCollector()
  topLevelRule.accept(collectorVisitor)
  const allRuleProductions = collectorVisitor.allProductions

  const productionsById: Record<string, IProductionWithOccurrence[]> = {}
  allRuleProductions.forEach((currProd) => {
    (productionsById[identifyProductionForDuplicates(currProd)] ??= []).push(currProd)
  })

  const duplicates = Object.values(productionsById).filter(
    (prods) => prods.length > 1
  )

  const errors = duplicates.map(
    (currDuplicates: IProductionWithOccurrence[]) => {
      const firstProd = currDuplicates[0]
      const msg = errMsgProvider.buildDuplicateFoundError(
        topLevelRule,
        currDuplicates
      )
      const dslName = getProductionDslName(firstProd)
      const defError: IParserDuplicatesDefinitionError = {
        message: msg,
        type: ParserDefinitionErrorType.DUPLICATE_PRODUCTIONS,
        ruleName: topLevelRule.name,
        dslName: dslName,
        occurrence: firstProd.idx
      }

      const param = getExtraProductionArgument(firstProd)
      if (param) {
        defError.parameter = param
      }

      return defError
    }
  )
  return errors
}

export function identifyProductionForDuplicates(
  prod: IProductionWithOccurrence
): string {
  return `${getProductionDslName(prod)}_#_${
    prod.idx
  }_#_${getExtraProductionArgument(prod)}`
}

function getExtraProductionArgument(prod: IProductionWithOccurrence): string {
  if (prod instanceof Terminal) {
    return prod.terminalType.name
  } else if (prod instanceof NonTerminal) {
    return prod.nonTerminalName
  } else {
    return ""
  }
}

export class OccurrenceValidationCollector extends GAstVisitor {
  public allProductions: IProductionWithOccurrence[] = []

  public visitNonTerminal(subrule: NonTerminal): void {
    this.allProductions.push(subrule)
  }

  public visitOption(option: Option): void {
    this.allProductions.push(option)
  }

  public visitRepetitionWithSeparator(manySep: RepetitionWithSeparator): void {
    this.allProductions.push(manySep)
  }

  public visitRepetitionMandatory(atLeastOne: RepetitionMandatory): void {
    this.allProductions.push(atLeastOne)
  }

  public visitRepetitionMandatoryWithSeparator(
    atLeastOneSep: RepetitionMandatoryWithSeparator
  ): void {
    this.allProductions.push(atLeastOneSep)
  }

  public visitRepetition(many: Repetition): void {
    this.allProductions.push(many)
  }

  public visitAlternation(or: Alternation): void {
    this.allProductions.push(or)
  }

  public visitTerminal(terminal: Terminal): void {
    this.allProductions.push(terminal)
  }
}

export function validateRuleDoesNotAlreadyExist(
  rule: Rule,
  allRules: Rule[],
  className: string,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserDefinitionError[] {
  const errors = []
  const occurrences = allRules.reduce((result, curRule) => {
    if (curRule.name === rule.name) {
      return result + 1
    }
    return result
  }, 0)
  if (occurrences > 1) {
    const errMsg = errMsgProvider.buildDuplicateRuleNameError({
      topLevelRule: rule,
      grammarName: className
    })
    errors.push({
      message: errMsg,
      type: ParserDefinitionErrorType.DUPLICATE_RULE_NAME,
      ruleName: rule.name
    })
  }

  return errors
}

// TODO: is there anyway to get only the rule names of rules inherited from the super grammars?
// This is not part of the IGrammarErrorProvider because the validation cannot be performed on
// The grammar structure, only at runtime.
export function validateRuleIsOverridden(
  ruleName: string,
  definedRulesNames: string[],
  className: string
): IParserDefinitionError[] {
  const errors = []
  let errMsg

  if (definedRulesNames.indexOf(ruleName) === -1) {
    errMsg =
      `Invalid rule override, rule: ->${ruleName}<- cannot be overridden in the grammar: ->${className}<-` +
      `as it is not defined in any of the super grammars `
    errors.push({
      message: errMsg,
      type: ParserDefinitionErrorType.INVALID_RULE_OVERRIDE,
      ruleName: ruleName
    })
  }

  return errors
}

export function validateNoLeftRecursion(
  topRule: Rule,
  currRule: Rule,
  errMsgProvider: IGrammarValidatorErrorMessageProvider,
  path: Rule[] = []
): IParserDefinitionError[] {
  const errors: IParserDefinitionError[] = []
  const nextNonTerminals = getFirstNoneTerminal(currRule.definition)
  if (nextNonTerminals.length === 0) {
    return []
  } else {
    const ruleName = topRule.name
    const foundLeftRecursion = nextNonTerminals.indexOf(topRule) !== -1
    if (foundLeftRecursion) {
      errors.push({
        message: errMsgProvider.buildLeftRecursionError({
          topLevelRule: topRule,
          leftRecursionPath: path
        }),
        type: ParserDefinitionErrorType.LEFT_RECURSION,
        ruleName: ruleName
      })
    }

    // we are only looking for cyclic paths leading back to the specific topRule
    // other cyclic paths are ignored, we still need this difference to avoid infinite loops...
    const pathAndTopRule = path.concat([topRule])
    const validNextSteps = nextNonTerminals.filter(
      (currNext) => pathAndTopRule.indexOf(currNext) === -1
    )
    const errorsFromNextSteps = flatMap(validNextSteps, (currRefRule) => {
      const newPath = path.slice()
      newPath.push(currRefRule)
      return validateNoLeftRecursion(
        topRule,
        currRefRule,
        errMsgProvider,
        newPath
      )
    })

    return errors.concat(errorsFromNextSteps)
  }
}

export function getFirstNoneTerminal(definition: IProduction[]): Rule[] {
  let result: Rule[] = []
  if (definition.length === 0) {
    return result
  }
  const firstProd = definition[0]

  /* istanbul ignore else */
  if (firstProd instanceof NonTerminal) {
    result.push(firstProd.referencedRule)
  } else if (
    firstProd instanceof AlternativeGAST ||
    firstProd instanceof Option ||
    firstProd instanceof RepetitionMandatory ||
    firstProd instanceof RepetitionMandatoryWithSeparator ||
    firstProd instanceof RepetitionWithSeparator ||
    firstProd instanceof Repetition
  ) {
    result = result.concat(
      getFirstNoneTerminal(<IProduction[]>firstProd.definition)
    )
  } else if (firstProd instanceof Alternation) {
    // each sub definition in alternation is a FLAT
    result = flatMap(firstProd.definition, (currSubDef) =>
      getFirstNoneTerminal((<AlternativeGAST>currSubDef).definition)
    )
  } else if (firstProd instanceof Terminal) {
    // nothing to see, move along
  } else {
    throw Error("non exhaustive match")
  }

  const isFirstOptional = isOptionalProd(firstProd)
  const hasMore = definition.length > 1
  if (isFirstOptional && hasMore) {
    const rest = definition.slice(1)
    return result.concat(getFirstNoneTerminal(rest))
  } else {
    return result
  }
}

class OrCollector extends GAstVisitor {
  public alternations: Alternation[] = []

  public visitAlternation(node: Alternation): void {
    this.alternations.push(node)
  }
}

export function validateEmptyOrAlternative(
  topLevelRule: Rule,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserEmptyAlternativeDefinitionError[] {
  const orCollector = new OrCollector()
  topLevelRule.accept(orCollector)
  const ors = orCollector.alternations

  const errors = flatMap<Alternation, IParserEmptyAlternativeDefinitionError>(
    ors,
    (currOr) => {
      const exceptLast = currOr.definition.slice(0, -1)
      return flatMap(exceptLast, (currAlternative, currAltIdx) => {
        const possibleFirstInAlt = nextPossibleTokensAfter(
          [currAlternative],
          [],
          tokenStructuredMatcher,
          1
        )
        if (possibleFirstInAlt.length === 0) {
          return [
            {
              message: errMsgProvider.buildEmptyAlternationError({
                topLevelRule: topLevelRule,
                alternation: currOr,
                emptyChoiceIdx: currAltIdx
              }),
              type: ParserDefinitionErrorType.NONE_LAST_EMPTY_ALT,
              ruleName: topLevelRule.name,
              occurrence: currOr.idx,
              alternative: currAltIdx + 1
            }
          ]
        } else {
          return []
        }
      })
    }
  )

  return errors
}

export function validateAmbiguousAlternationAlternatives(
  topLevelRule: Rule,
  globalMaxLookahead: number,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserAmbiguousAlternativesDefinitionError[] {
  const orCollector = new OrCollector()
  topLevelRule.accept(orCollector)
  let ors = orCollector.alternations

  // New Handling of ignoring ambiguities
  // - https://github.com/chevrotain/chevrotain/issues/869
  ors = ors.filter((currOr) => currOr.ignoreAmbiguities !== true)

  const errors = flatMap(ors, (currOr: Alternation) => {
    const currOccurrence = currOr.idx
    const actualMaxLookahead = currOr.maxLookahead || globalMaxLookahead
    const alternatives = getLookaheadPathsForOr(
      currOccurrence,
      topLevelRule,
      actualMaxLookahead,
      currOr
    )
    const altsAmbiguityErrors = checkAlternativesAmbiguities(
      alternatives,
      currOr,
      topLevelRule,
      errMsgProvider
    )
    const altsPrefixAmbiguityErrors = checkPrefixAlternativesAmbiguities(
      alternatives,
      currOr,
      topLevelRule,
      errMsgProvider
    )

    return altsAmbiguityErrors.concat(altsPrefixAmbiguityErrors)
  })

  return errors
}

export class RepetitionCollector extends GAstVisitor {
  public allProductions: (IProductionWithOccurrence & {
    maxLookahead?: number
  })[] = []

  public visitRepetitionWithSeparator(manySep: RepetitionWithSeparator): void {
    this.allProductions.push(manySep)
  }

  public visitRepetitionMandatory(atLeastOne: RepetitionMandatory): void {
    this.allProductions.push(atLeastOne)
  }

  public visitRepetitionMandatoryWithSeparator(
    atLeastOneSep: RepetitionMandatoryWithSeparator
  ): void {
    this.allProductions.push(atLeastOneSep)
  }

  public visitRepetition(many: Repetition): void {
    this.allProductions.push(many)
  }
}

export function validateTooManyAlts(
  topLevelRule: Rule,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserDefinitionError[] {
  const orCollector = new OrCollector()
  topLevelRule.accept(orCollector)
  const ors = orCollector.alternations

  const errors = flatMap(ors, (currOr) => {
    if (currOr.definition.length > 255) {
      return [
        {
          message: errMsgProvider.buildTooManyAlternativesError({
            topLevelRule: topLevelRule,
            alternation: currOr
          }),
          type: ParserDefinitionErrorType.TOO_MANY_ALTS,
          ruleName: topLevelRule.name,
          occurrence: currOr.idx
        }
      ]
    } else {
      return []
    }
  })

  return errors
}

export function validateSomeNonEmptyLookaheadPath(
  topLevelRules: Rule[],
  maxLookahead: number,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserDefinitionError[] {
  const errors: IParserDefinitionError[] = []
  topLevelRules.forEach((currTopRule) => {
    const collectorVisitor = new RepetitionCollector()
    currTopRule.accept(collectorVisitor)
    const allRuleProductions = collectorVisitor.allProductions
    allRuleProductions.forEach((currProd) => {
      const prodType = getProdType(currProd)
      const actualMaxLookahead = currProd.maxLookahead || maxLookahead
      const currOccurrence = currProd.idx
      const paths = getLookaheadPathsForOptionalProd(
        currOccurrence,
        currTopRule,
        prodType,
        actualMaxLookahead
      )
      const pathsInsideProduction = paths[0]
      if (pathsInsideProduction.every((path) => path.length === 0)) {
        const errMsg = errMsgProvider.buildEmptyRepetitionError({
          topLevelRule: currTopRule,
          repetition: currProd
        })
        errors.push({
          message: errMsg,
          type: ParserDefinitionErrorType.NO_NON_EMPTY_LOOKAHEAD,
          ruleName: currTopRule.name
        })
      }
    })
  })

  return errors
}

export interface IAmbiguityDescriptor {
  alts: number[]
  path: TokenType[]
}

function checkAlternativesAmbiguities(
  alternatives: Alternative[],
  alternation: Alternation,
  rule: Rule,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserAmbiguousAlternativesDefinitionError[] {
  const foundAmbiguousPaths: Alternative = []
  const identicalAmbiguities = alternatives.reduce(
    (result, currAlt, currAltIdx) => {
      // ignore (skip) ambiguities with this alternative
      if (alternation.definition[currAltIdx].ignoreAmbiguities === true) {
        return result
      }

      currAlt.forEach((currPath) => {
        const altsCurrPathAppearsIn = [currAltIdx]
        alternatives.forEach((currOtherAlt, currOtherAltIdx) => {
          if (
            currAltIdx !== currOtherAltIdx &&
            containsPath(currOtherAlt, currPath) &&
            // ignore (skip) ambiguities with this "other" alternative
            alternation.definition[currOtherAltIdx].ignoreAmbiguities !== true
          ) {
            altsCurrPathAppearsIn.push(currOtherAltIdx)
          }
        })

        if (
          altsCurrPathAppearsIn.length > 1 &&
          !containsPath(foundAmbiguousPaths, currPath)
        ) {
          foundAmbiguousPaths.push(currPath)
          result.push({
            alts: altsCurrPathAppearsIn,
            path: currPath
          })
        }
      })
      return result
    },
    [] as { alts: number[]; path: TokenType[] }[]
  )

  const currErrors = identicalAmbiguities.map((currAmbDescriptor) => {
    const ambgIndices = currAmbDescriptor.alts.map(
      (currAltIdx) => currAltIdx + 1
    )

    const currMessage = errMsgProvider.buildAlternationAmbiguityError({
      topLevelRule: rule,
      alternation: alternation,
      ambiguityIndices: ambgIndices,
      prefixPath: currAmbDescriptor.path
    })

    return {
      message: currMessage,
      type: ParserDefinitionErrorType.AMBIGUOUS_ALTS,
      ruleName: rule.name,
      occurrence: alternation.idx,
      alternatives: currAmbDescriptor.alts
    }
  })

  return currErrors
}

export function checkPrefixAlternativesAmbiguities(
  alternatives: Alternative[],
  alternation: Alternation,
  rule: Rule,
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserAmbiguousAlternativesDefinitionError[] {
  // flatten
  const pathsAndIndices = alternatives.reduce((result, currAlt, idx) => {
    const currPathsAndIdx = currAlt.map((currPath) => {
      return { idx: idx, path: currPath }
    })
    return result.concat(currPathsAndIdx)
  }, [] as { idx: number; path: TokenType[] }[])

  const errors =
    flatMap(pathsAndIndices, (currPathAndIdx) => {
      const alternativeGast = alternation.definition[currPathAndIdx.idx]
      // ignore (skip) ambiguities with this alternative
      if (alternativeGast.ignoreAmbiguities === true) {
        return []
      }
      const targetIdx = currPathAndIdx.idx
      const targetPath = currPathAndIdx.path

      const prefixAmbiguitiesPathsAndIndices = pathsAndIndices.filter(
        (searchPathAndIdx) => {
          // prefix ambiguity can only be created from lower idx (higher priority) path
          return (
            // ignore (skip) ambiguities with this "other" alternative
            alternation.definition[searchPathAndIdx.idx].ignoreAmbiguities !==
              true &&
            searchPathAndIdx.idx < targetIdx &&
            // checking for strict prefix because identical lookaheads
            // will be be detected using a different validation.
            isStrictPrefixOfPath(searchPathAndIdx.path, targetPath)
          )
        }
      )

      const currPathPrefixErrors = prefixAmbiguitiesPathsAndIndices.map(
        (currAmbPathAndIdx): IParserAmbiguousAlternativesDefinitionError => {
          const ambgIndices = [currAmbPathAndIdx.idx + 1, targetIdx + 1]
          const occurrence = alternation.idx === 0 ? "" : alternation.idx

          const message = errMsgProvider.buildAlternationPrefixAmbiguityError({
            topLevelRule: rule,
            alternation: alternation,
            ambiguityIndices: ambgIndices,
            prefixPath: currAmbPathAndIdx.path
          })
          return {
            message: message,
            type: ParserDefinitionErrorType.AMBIGUOUS_PREFIX_ALTS,
            ruleName: rule.name,
            occurrence: occurrence,
            alternatives: ambgIndices
          }
        }
      )

      return currPathPrefixErrors
    })

  return errors.filter((currError) => !!currError)
}

function checkTerminalAndNoneTerminalsNameSpace(
  topLevels: Rule[],
  tokenTypes: TokenType[],
  errMsgProvider: IGrammarValidatorErrorMessageProvider
): IParserDefinitionError[] {
  const errors: IParserDefinitionError[] = []

  const tokenNames = tokenTypes.map((currToken) => currToken.name)

  topLevels.forEach((currRule) => {
    const currRuleName = currRule.name
    if (tokenNames.indexOf(currRuleName) !== -1) {
      const errMsg = errMsgProvider.buildNamespaceConflictError(currRule)

      errors.push({
        message: errMsg,
        type: ParserDefinitionErrorType.CONFLICT_TOKENS_RULES_NAMESPACE,
        ruleName: currRuleName
      })
    }
  })

  return errors
}
