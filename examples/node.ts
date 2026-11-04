import { Node } from '../src/index.ts'

export class BotNode extends Node {
  public reportedErrors = 0

  override reportError(error: unknown) {
    this.reportedErrors++
    // Keep the standard logging and nodeError events.
    super.reportError(error)
  }
}
