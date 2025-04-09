import { SourceRange } from "../../Source/SourceRange";
import { PebbleExpr } from "../expr/PebbleExpr";
import { HasSourceRange } from "../HasSourceRange";
import { PebbleStmt } from "./PebbleStmt";

export class WhileStmt
    implements HasSourceRange
{
    constructor(
        readonly condition: PebbleExpr,
        readonly body: PebbleStmt,
        readonly range: SourceRange,
    ) {}
}