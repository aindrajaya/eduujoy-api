import { type ContractException } from './compare';

/**
 * Approved differences between this build and the contract. Each entry names the slice that removes
 * it; delete the entry in that slice. Anything not listed here fails `pnpm openapi:check`.
 */
export const CONTRACT_EXCEPTIONS: ContractException[] = [];
