import type { HelperApi } from '../../shared/contracts'
declare global {
  interface Window {
    kimiHelper: HelperApi
  }
}
