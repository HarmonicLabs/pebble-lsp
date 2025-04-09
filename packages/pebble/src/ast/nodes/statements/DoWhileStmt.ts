import { SourceRange } from "../../Source/SourceRange";
import { PebbleExpr } from "../expr/PebbleExpr";
import { HasSourceRange } from "../HasSourceRange";
import { PebbleStmt } from "./PebbleStmt";

export class DoWhileStmt
    implements HasSourceRange
{
    constructor(
        readonly body: PebbleStmt,
        readonly condition: PebbleExpr,
        readonly range: SourceRange,
    ) {}
}