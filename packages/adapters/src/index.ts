export type { MarketplaceAdapter, AdapterDescriptor } from "./types";
export {
  getAdapter,
  getDescriptor,
  activeMarketplaces,
} from "./registry";
export { closeBrowser } from "./browser";
/**
 * Ricerca Taobao con la sessione dell'utente: non passa dal registry perché
 * non è un adapter generico — richiede cookie autenticati, che il registry non
 * ha modo di fornire.
 */
export {
  searchTaobaoAuthenticated,
  normalizeCookies,
  buildSearchUrl as buildTaobaoSearchUrl,
  isVerificationUrl as isTaobaoVerificationUrl,
  parseBrowserPrice as parseTaobaoBrowserPrice,
  parseBrowserSales as parseTaobaoBrowserSales,
  TaobaoBrowserError,
  VERIFICATION_MESSAGE as TAOBAO_VERIFICATION_MESSAGE,
  type TaobaoBrowserProduct,
  type TaobaoBrowserResult,
  type TaobaoBrowserErrorCode,
} from "./adapters/taobao-auth";
