import { Token } from "../Token";

export function tokenIsAlsoIdentifier(token: Token): boolean {
    switch (token) {
        // case Token.Abstract:
        case Token.As:
        // case Token.Constructor:
        // case Token.Declare:
        // case Token.Delete:
        case Token.From:
        // case Token.For:  // not allowed
        // case Token.Get:
        // case Token.Set:
        // case Token.InstanceOf:  // not allowed
        case Token.Is:
        // case Token.KeyOf:
        // case Token.Module:
        // case Token.Namespace:
        // case Token.Null:
        case Token.Readonly:
        // case Token.Type: // we don't allow it in pebble
        case Token.Void: return true;
        default: return false;
    }
}