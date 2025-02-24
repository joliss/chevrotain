import {
  IParserUnresolvedRefDefinitionError,
  ParserDefinitionErrorType
} from "../parser/parser"
import { NonTerminal, Rule } from "@chevrotain/gast"
import { GAstVisitor } from "@chevrotain/gast"
import {
  IGrammarResolverErrorMessageProvider,
  IParserDefinitionError
} from "./types"

export function resolveGrammar(
  topLevels: Record<string, Rule>,
  errMsgProvider: IGrammarResolverErrorMessageProvider
): IParserDefinitionError[] {
  const refResolver = new GastRefResolverVisitor(topLevels, errMsgProvider)
  refResolver.resolveRefs()
  return refResolver.errors
}

export class GastRefResolverVisitor extends GAstVisitor {
  public errors: IParserUnresolvedRefDefinitionError[] = []
  private currTopLevel: Rule

  constructor(
    private nameToTopRule: Record<string, Rule>,
    private errMsgProvider: IGrammarResolverErrorMessageProvider
  ) {
    super()
  }

  public resolveRefs(): void {
    Object.values(this.nameToTopRule).forEach((prod) => {
      this.currTopLevel = prod
      prod.accept(this)
    })
  }

  public visitNonTerminal(node: NonTerminal): void {
    const ref = this.nameToTopRule[node.nonTerminalName]

    if (!ref) {
      const msg = this.errMsgProvider.buildRuleNotFoundError(
        this.currTopLevel,
        node
      )
      this.errors.push({
        message: msg,
        type: ParserDefinitionErrorType.UNRESOLVED_SUBRULE_REF,
        ruleName: this.currTopLevel.name,
        unresolvedRefName: node.nonTerminalName
      })
    } else {
      node.referencedRule = ref
    }
  }
}
