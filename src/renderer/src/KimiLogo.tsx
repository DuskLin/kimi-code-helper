import monochrome from './assets/kimi.svg'
import color from './assets/kimi-color.svg'

export function KimiLogo() {
  return (
    <span className="kimi-logo" role="img" aria-label="Kimi">
      <img className="kimi-logo-mono" src={monochrome} alt="" aria-hidden="true" />
      <img className="kimi-logo-color" src={color} alt="" aria-hidden="true" />
    </span>
  )
}
