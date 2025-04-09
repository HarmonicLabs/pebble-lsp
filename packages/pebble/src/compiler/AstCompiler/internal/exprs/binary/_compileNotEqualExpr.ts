import { NotEqualExpr } from "../../../../../ast/nodes/expr/binary/BinaryExpr";
import { DiagnosticCode } from "../../../../../diagnostics/diagnosticMessages.generated";
import { TirNotEqualExpr } from "../../../../tir/expressions/binary/TirBinaryExpr";
import { TirType } from "../../../../tir/types/TirType";
import { canAssignTo } from "../../../../tir/types/type-check-utils/canAssignTo";
import { AstCompilationCtx } from "../../../AstCompilationCtx";
import { _compileExpr } from "../_compileExpr";


export function _compileNotEqualExpr(
    ctx: AstCompilationCtx,
    expr: NotEqualExpr,
    typeHint: TirType | undefined
): TirNotEqualExpr | undefined
{
    const left = _compileExpr( ctx, expr.left, typeHint );
    if( !left ) return undefined;

    const leftType = left.type;

    const right = _compileExpr( ctx, expr.right, leftType );
    if( !right ) return undefined;

    if( !canAssignTo( right.type, leftType ) )
    return ctx.error(
        DiagnosticCode.Type_0_is_not_assignable_to_type_1,
        expr.right.range, right.type.toString(), leftType.toString()
    );

    return new TirNotEqualExpr(
        left,
        right,
        // implicit bool type,
        expr.range
    );
}