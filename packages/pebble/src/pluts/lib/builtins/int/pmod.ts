import { intBinOpToInt } from "./intBinOpToInt";
import { IRNative } from "../../../../IR/IRNodes/IRNative";

export const pmod = intBinOpToInt( IRNative.modInteger );