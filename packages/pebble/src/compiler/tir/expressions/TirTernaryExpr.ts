import { HasSourceRange } from "../../../ast/nodes/HasSourceRange";
import { SourceRange } from "../../../ast/Source/SourceRange";
import { TirType } from "../types/TirType";
import { ITirExpr } from "./ITirExpr";
import { TirExpr } from "./TirExpr";

export class TirTernaryExpr
    implements ITirExpr
{
    constructor(
        readonly condition: TirExpr,
        readonly ifTrue: TirExpr,
        readonly ifFalse: TirExpr,
        readonly type: TirType,
        readonly range: SourceRange
    ) {}
}