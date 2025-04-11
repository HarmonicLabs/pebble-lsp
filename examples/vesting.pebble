import { Address, bool, compile, data, Credential, pBool, pdelay, pfn, pmatch, PScriptContext, pStr, ptraceIfFalse, Script, ScriptType, plet, passert, perror, PMaybe, unit, punsafeConvertType } from "@harmoniclabs/plu-ts";
import VestingDatum from "./VestingDatum";

export const contract = pfn([
    PScriptContext.type
],  unit)
(( {redeemer, tx, purpose} ) => {

  const maybeDatum = plet(
    pmatch(purpose)
    .onSpending(({ datum }) => datum)
    ._(_ => perror(PMaybe(data).type))
  );

     const datum = plet( punsafeConvertType( maybeDatum.unwrap, VestingDatum.type ) )

     const signedByBeneficiary = tx.signatories.some( datum.beneficiary.eq )

    // inlined
    const deadlineReached = plet(
        pmatch( tx.interval.from.bound )
        .onPFinite(({ n: lowerInterval }) =>
            datum.deadline.ltEq( lowerInterval ) 
        )
        ._( _ => pBool( false ) )
    )

    return passert.$(
        (ptraceIfFalse.$(pdelay(pStr("Error in signedByBenificiary"))).$(signedByBeneficiary))
        .and( ptraceIfFalse.$(pdelay(pStr("deadline not reached or not specified"))).$( deadlineReached ) )
      );

});

///////////////////////////////////////////////////////////////////
// ------------------------------------------------------------- //
// ------------------------- utilities ------------------------- //
// ------------------------------------------------------------- //
///////////////////////////////////////////////////////////////////


export const compiledContract = compile( contract );

export const script = new Script(
    ScriptType.PlutusV3,
    compiledContract
);

export const scriptMainnetAddr = new Address(
    "mainnet",
    Credential.script( script.hash )
);

export const scriptTestnetAddr = new Address(
    "testnet",
    Credential.script( script.hash )
);

export default contract;
