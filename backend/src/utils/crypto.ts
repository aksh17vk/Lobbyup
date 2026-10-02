import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 256-bit opaque token, URL safe. */
export const generateToken = () => randomBytes(32).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Cryptographically secure RNG in [0, 1) suitable for shuffling exam content. */
export const secureRandom = () => randomInt(0, 2 ** 47) / 2 ** 47;
