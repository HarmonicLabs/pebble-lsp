import {
  Address,
  PScriptContext,
  ScriptType,
  Credential,
  Script,
  compile,
  pfn,
  plet,
  unit,
  pmatch,
  perror,
  passert,
  pstruct,
  punIData,
  pisEmpty,
  punBData,
  pBool,
  PTxOutRef,
  parseUPLC,
  UPLCProgram,
  Application,
  TxOutRef,
  UPLCConst,
  compileUPLC,
  int,
  punsafeConvertType,
  ptraceIfFalse,
  pdelay,
  pStr,
} from "@harmoniclabs/plu-ts";

const ASSET_NAME = "Test Token";
const MAX_SUPPLY = 10;

export const MintAction = pstruct({
  Mint: {},
  Burn: {},
  Init: {}
})

export const contract = pfn([
  PTxOutRef.type,
  PScriptContext.type,
], unit)
((mustSpendInitUtxo, { redeemer, tx, purpose }) => {

  const action = plet(redeemer.as(MintAction.type));

  return pmatch(purpose)
    .onMinting(({ currencySym }) =>
      pmatch(action)
        .onInit(() => 
          passert.$(
            pisEmpty.$(tx.inputs.tail) // only one input
            .and(tx.inputs.head.utxoRef.eq(mustSpendInitUtxo)) // make sure we only call init once
            .and(
              // we mint a single nft
              tx.mint.head.fst.eq(currencySym)
              .and(tx.mint.head.snd.length.eq(1))
              .and(tx.mint.head.snd.head.fst.eq(ASSET_NAME))
              .and(tx.mint.head.snd.head.snd.eq(1))
            )
            .and(
              plet(tx.outputs.head).in(out =>
                // make sure the nft is sent to the contract
                out.address.credential.hash.eq(currencySym)
                  .and(punsafeConvertType(out.value.amountOf(currencySym, ASSET_NAME), int).eq(1))
                  // the initial datum is 0
                  .and(
                    pmatch(out.datum)
                    .onInlineDatum(({ datum }) => punIData.$(datum).eq(0))
                    ._(_ => pBool(false))
                  )
              )
            )
          )
        )
        .onMint(() =>
          passert.$(ptraceIfFalse.$(pdelay(pStr("onMint"))).$(
            tx.inputs.some(i => i.resolved.address.credential.hash.eq(currencySym))
          ))
        )
        .onBurn(() => 
          passert.$(ptraceIfFalse.$(pdelay(pStr("onBurn"))).$(
            tx.mint.filter(i => i.fst.eq(currencySym)).head.snd.every(m => m.snd.lt(0))
          ))
        )
    )
    .onSpending(({ utxoRef, datum }) => {

      const maybeInput = tx.inputs.find(i => i.utxoRef.eq(utxoRef) );

      const input = plet(maybeInput).unwrap;

      const ownHash = punBData.$(input.resolved.address.credential.raw.fields.head);

      const hasOwnershipToken = plet(input.resolved.value.amountOf(ownHash, ASSET_NAME).gtEq(1));

      const paymentCredential = input.resolved.address.credential;

      const id = plet(punIData.$(datum.unwrap));

      const hasOwnHashAsFirst = pisEmpty.$(tx.mint.tail).and(tx.mint.head.fst.eq(ownHash));

      const ownMintedAssets = plet(tx.mint.head.snd);

      const userName = ownMintedAssets.head.fst;

      const userQuantity = ownMintedAssets.head.snd;

      const assetNameWithId = `${ASSET_NAME}#${id}`;

      const hasCorrectName = userName.eq(assetNameWithId);

      const hasCorrectMintingQuantity = userQuantity.eq(1);

      const hasValidSupply = id.lt(MAX_SUPPLY);

      const outputs = tx.outputs.filter(o => o.address.credential.eq(paymentCredential));

      const hasOnlyOneOuput = outputs.length.eq(1);

      const hasIncreasedId = pmatch(outputs.head.datum)
        .onInlineDatum(({ datum }) => punIData.$(datum).eq(id.add(1)))
        ._(_ => pBool(false));

      const hasCorrectValue = outputs.head.value.lovelaces.eq(input.resolved.value.lovelaces);

      return passert.$(
        ptraceIfFalse.$(pdelay(pStr("hasOwnershipToken"))).$(hasOwnershipToken)
        .and(ptraceIfFalse.$(pdelay(pStr("hasOwnHashAsFirst"))).$(hasOwnHashAsFirst))
        .and(ptraceIfFalse.$(pdelay(pStr("hasCorrectName"))).$(hasCorrectName))
        .and(ptraceIfFalse.$(pdelay(pStr("hasCorrectMintingQuantity"))).$(hasCorrectMintingQuantity))
        .and(ptraceIfFalse.$(pdelay(pStr("hasValidSupply"))).$(hasValidSupply))
        .and(ptraceIfFalse.$(pdelay(pStr("hasOnlyOneOuput"))).$(hasOnlyOneOuput))
        .and(ptraceIfFalse.$(pdelay(pStr("hasIncreasedId"))).$(hasIncreasedId))
        .and(ptraceIfFalse.$(pdelay(pStr("hasCorrectValue"))).$(hasCorrectValue)));
    })
    ._(_ => perror(unit));
});

export const compiledContract = compile(contract);

export function getFinalContract(utxoRef: TxOutRef): {
  script: Script,
  credential: Credential,
  address: Address,
  testnetAddress: Address
}
{
  const program = parseUPLC(compiledContract);

  const applyiedProgram = new UPLCProgram(
    program.version,
    new Application(
      program.body,
      UPLCConst.data(utxoRef.toData("v3"))
    )
  );

  const finalCompiled = compileUPLC(applyiedProgram).toBuffer().buffer;

  const script = new Script(
    ScriptType.PlutusV3,
    finalCompiled
  );

  const credential = Credential.script(script.hash);
  const address = Address.mainnet(credential);
  const testnetAddress = Address.testnet(credential);

  return {
    script,
    credential,
    address,
    testnetAddress
  };
}