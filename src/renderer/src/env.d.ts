import type { HelperApi } from '../../shared/contracts'
declare global {
  interface Window {
    navo: HelperApi
  }
}
