import {
  Alternative,
  Atom,
  BaseRegExpVisitor,
  Character,
  Disjunction,
  Group,
  Set,
  Term,
  VERSION
} from "regexp-to-ast"
import { PRINT_ERROR, PRINT_WARNING } from "@chevrotain/utils"
import { ASTNode, getRegExpAst } from "./reg_exp_parser"
import { charCodeToOptimizedIndex, minOptimizationVal } from "./lexer"

const complementErrorMessage =
  "Complement Sets are not supported for first char optimization"
export const failedOptimizationPrefixMsg =
  'Unable to use "first char" lexer optimizations:\n'

export function getOptimizedStartCodesIndices(
  regExp: RegExp,
  ensureOptimizations = false
): number[] {
  try {
    const ast = getRegExpAst(regExp)
    const firstChars = firstCharOptimizedIndices(
      ast.value,
      {},
      ast.flags.ignoreCase
    )
    return firstChars
  } catch (e) {
    /* istanbul ignore next */
    // Testing this relies on the regexp-to-ast library having a bug... */
    // TODO: only the else branch needs to be ignored, try to fix with newer prettier / tsc
    if (e.message === complementErrorMessage) {
      if (ensureOptimizations) {
        PRINT_WARNING(
          `${failedOptimizationPrefixMsg}` +
            `\tUnable to optimize: < ${regExp.toString()} >\n` +
            "\tComplement Sets cannot be automatically optimized.\n" +
            "\tThis will disable the lexer's first char optimizations.\n" +
            "\tSee: https://chevrotain.io/docs/guide/resolving_lexer_errors.html#COMPLEMENT for details."
        )
      }
    } else {
      let msgSuffix = ""
      if (ensureOptimizations) {
        msgSuffix =
          "\n\tThis will disable the lexer's first char optimizations.\n" +
          "\tSee: https://chevrotain.io/docs/guide/resolving_lexer_errors.html#REGEXP_PARSING for details."
      }
      PRINT_ERROR(
        `${failedOptimizationPrefixMsg}\n` +
          `\tFailed parsing: < ${regExp.toString()} >\n` +
          `\tUsing the regexp-to-ast library version: ${VERSION}\n` +
          "\tPlease open an issue at: https://github.com/bd82/regexp-to-ast/issues" +
          msgSuffix
      )
    }
  }

  return []
}

export function firstCharOptimizedIndices(
  ast: ASTNode,
  result: { [charCode: number]: number },
  ignoreCase: boolean
): number[] {
  switch (ast.type) {
    case "Disjunction":
      for (let i = 0; i < ast.value.length; i++) {
        firstCharOptimizedIndices(ast.value[i], result, ignoreCase)
      }
      break
    case "Alternative":
      const terms = ast.value
      for (let i = 0; i < terms.length; i++) {
        const term = terms[i]

        // skip terms that cannot effect the first char results
        switch (term.type) {
          case "EndAnchor":
          // A group back reference cannot affect potential starting char.
          // because if a back reference is the first production than automatically
          // the group being referenced has had to come BEFORE so its codes have already been added
          case "GroupBackReference":
          // assertions do not affect potential starting codes
          case "Lookahead":
          case "NegativeLookahead":
          case "StartAnchor":
          case "WordBoundary":
          case "NonWordBoundary":
            continue
        }

        const atom = term
        switch (atom.type) {
          case "Character":
            addOptimizedIdxToResult(atom.value, result, ignoreCase)
            break
          case "Set":
            if (atom.complement === true) {
              throw Error(complementErrorMessage)
            }
            atom.value.forEach((code) => {
              if (typeof code === "number") {
                addOptimizedIdxToResult(code, result, ignoreCase)
              } else {
                // range
                const range = code as any
                // cannot optimize when ignoreCase is
                if (ignoreCase === true) {
                  for (
                    let rangeCode = range.from;
                    rangeCode <= range.to;
                    rangeCode++
                  ) {
                    addOptimizedIdxToResult(rangeCode, result, ignoreCase)
                  }
                }
                // Optimization (2 orders of magnitude less work for very large ranges)
                else {
                  // handle unoptimized values
                  for (
                    let rangeCode = range.from;
                    rangeCode <= range.to && rangeCode < minOptimizationVal;
                    rangeCode++
                  ) {
                    addOptimizedIdxToResult(rangeCode, result, ignoreCase)
                  }

                  // Less common charCode where we optimize for faster init time, by using larger "buckets"
                  if (range.to >= minOptimizationVal) {
                    const minUnOptVal =
                      range.from >= minOptimizationVal
                        ? range.from
                        : minOptimizationVal
                    const maxUnOptVal = range.to
                    const minOptIdx = charCodeToOptimizedIndex(minUnOptVal)
                    const maxOptIdx = charCodeToOptimizedIndex(maxUnOptVal)

                    for (
                      let currOptIdx = minOptIdx;
                      currOptIdx <= maxOptIdx;
                      currOptIdx++
                    ) {
                      result[currOptIdx] = currOptIdx
                    }
                  }
                }
              }
            })
            break
          case "Group":
            firstCharOptimizedIndices(atom.value, result, ignoreCase)
            break
          /* istanbul ignore next */
          default:
            throw Error("Non Exhaustive Match")
        }

        // reached a mandatory production, no more **start** codes can be found on this alternative
        const isOptionalQuantifier =
          atom.quantifier !== undefined && atom.quantifier.atLeast === 0
        if (
          // A group may be optional due to empty contents /(?:)/
          // or if everything inside it is optional /((a)?)/
          (atom.type === "Group" && isWholeOptional(atom) === false) ||
          // If this term is not a group it may only be optional if it has an optional quantifier
          (atom.type !== "Group" && isOptionalQuantifier === false)
        ) {
          break
        }
      }
      break
    /* istanbul ignore next */
    default:
      throw Error("non exhaustive match!")
  }

  // console.log(Object.keys(result).length)
  return Object.values(result)
}

function addOptimizedIdxToResult(
  code: number,
  result: { [charCode: number]: number },
  ignoreCase: boolean
) {
  const optimizedCharIdx = charCodeToOptimizedIndex(code)
  result[optimizedCharIdx] = optimizedCharIdx

  if (ignoreCase === true) {
    handleIgnoreCase(code, result)
  }
}

function handleIgnoreCase(
  code: number,
  result: { [charCode: number]: number }
) {
  const char = String.fromCharCode(code)
  const upperChar = char.toUpperCase()
  /* istanbul ignore else */
  if (upperChar !== char) {
    const optimizedCharIdx = charCodeToOptimizedIndex(upperChar.charCodeAt(0))
    result[optimizedCharIdx] = optimizedCharIdx
  } else {
    const lowerChar = char.toLowerCase()
    if (lowerChar !== char) {
      const optimizedCharIdx = charCodeToOptimizedIndex(lowerChar.charCodeAt(0))
      result[optimizedCharIdx] = optimizedCharIdx
    }
  }
}

function findCode(setNode: Set, targetCharCodes: number[]) {
  return setNode.value.find((codeOrRange) => {
    if (typeof codeOrRange === "number") {
      return targetCharCodes.indexOf(codeOrRange) !== -1
    } else {
      // range
      const range = <any>codeOrRange
      return (
        targetCharCodes.some(
          (targetCode) => range.from <= targetCode && targetCode <= range.to
        )
      )
    }
  })
}

function isWholeOptional(ast: any): boolean {
  const quantifier = (ast as Atom).quantifier
  if (quantifier && quantifier.atLeast === 0) {
    return true
  }

  if (!ast.value) {
    return false
  }

  return Array.isArray(ast.value)
    ? ast.value.every(isWholeOptional)
    : isWholeOptional(ast.value)
}

class CharCodeFinder extends BaseRegExpVisitor {
  found: boolean = false

  constructor(private targetCharCodes: number[]) {
    super()
  }

  visitChildren(node: ASTNode) {
    // No need to keep looking...
    if (this.found === true) {
      return
    }

    // switch lookaheads as they do not actually consume any characters thus
    // finding a charCode at lookahead context does not mean that regexp can actually contain it in a match.
    switch (node.type) {
      case "Lookahead":
        this.visitLookahead(node)
        return
      case "NegativeLookahead":
        this.visitNegativeLookahead(node)
        return
    }

    super.visitChildren(node)
  }

  visitCharacter(node: Character) {
    if (this.targetCharCodes.indexOf(node.value) !== -1) {
      this.found = true
    }
  }

  visitSet(node: Set) {
    if (node.complement) {
      if (findCode(node, this.targetCharCodes) === undefined) {
        this.found = true
      }
    } else {
      if (findCode(node, this.targetCharCodes) !== undefined) {
        this.found = true
      }
    }
  }
}

export function canMatchCharCode(
  charCodes: number[],
  pattern: RegExp | string
) {
  if (pattern instanceof RegExp) {
    const ast = getRegExpAst(pattern)
    const charCodeFinder = new CharCodeFinder(charCodes)
    charCodeFinder.visit(ast)
    return charCodeFinder.found
  } else {
    return (
      Array.from(pattern).some((char) =>
        charCodes.indexOf(char.charCodeAt(0)) !== -1
      )
    )
  }
}
