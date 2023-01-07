import { customAlphabet } from "nanoid";

// https://en.bitcoinwiki.org/wiki/Base58
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const mkId = customAlphabet(alphabet, 12);
