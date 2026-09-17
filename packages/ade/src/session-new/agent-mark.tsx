/**
 * One mark per agent, drawn rather than loaded.
 *
 * `agents.ts` used to carry a single character per agent with the note
 * "stand-in for the product mark, until real icons are wired". This is that
 * wiring, and the field is gone. A row of twelve buttons distinguished only by
 * ✳ ◎ ✦ ◧ ◆ ◉ is a row nobody scans: the whole reason to show the agents
 * rather than a dropdown is that a mark is recognised before a word is read,
 * and a geometric placeholder is not recognised at all.
 *
 * Drawn inline, and not fetched: the window's CSP allows images only from
 * `self`, `data:` and `blob:`, so a logo pulled from a CDN would be a blank
 * square with no error. Inline also means the monochrome marks take
 * `currentColor` and stay legible in both themes, which an `<img>` cannot do —
 * the same reason `NikLogo` exists as a component instead of as the asset it
 * was copied from.
 *
 * ── Where the marks come from ──────────────────────────────────────────────
 *
 * Published geometry, copied, not redrawn by eye. A logo traced from a
 * screenshot is wrong in a way nobody can point at, so each path below is the
 * vendor's own, with its source named above it:
 *
 *   claude-code  simple-icons `claude.svg`, taken from claude.ai
 *   codex        Codex's own mark — the OpenAI silhouette with a `>_` cut out
 *                — from `@lobehub/icons-static-svg`, kept in `vendor-paths.ts`.
 *                The bare rosette that stood here named the company, not the
 *                product, in a colour OpenAI retired
 *   opencode     anomalyco/opencode, `packages/identity/mark.svg`
 *   agy          Google Antigravity's arch and its blurred colour field, from
 *                `@lobehub/icons-static-svg` (`antigravity.svg`,
 *                `antigravity-color.svg`), kept in `vendor-paths.ts`
 *   kimi         simple-icons `kimi.svg`, from Moonshot's own Branding-Guide
 *   prime        PrimeIntellect-ai/prime-agent, `assets/brand/prime-butterfly.svg`
 *   pi           `pi.dev/logo-auto.svg`
 *   ohmypi       can1357/oh-my-pi, `assets/icon.svg`
 *   nikcli       `packages/console/app/src/asset/brand/nikcli-logo-dark.svg`
 *   hermes       Nous Research's profile portrait, from `@lobehub/icons-static-svg`,
 *                kept in `vendor-paths.ts`. What stood here was the word NOUS
 *                set in a serif inside a red ring — a description of the logo,
 *                not the logo
 *   terminal     ADE's own icon — a shell is not somebody's product
 *
 * simple-icons normalises a vendor's mark onto a 24×24 grid and releases the
 * SVG code as CC0; the mark itself stays the owner's. Every mark here is
 * somebody else's trademark, shown to name the product ADE is about to start
 * — nominative use, the thing a launcher is for. None of it implies the
 * vendor endorses ADE.
 *
 * ── And the colours ────────────────────────────────────────────────────────
 *
 * The vendor's, from the same files, and only where the vendor has one.
 * Claude is `#D97757`, Kimi's dot is `#1783FF`, OhMyPi's plug is `#F97316`,
 * OpenCode's ring is its off-white, Codex is a lilac-to-blue gradient and
 * Antigravity is a field of blurred Google colours cut to the arch. Prime,
 * pi and Nous ship black-on-white and white-on-black and nothing more, and
 * take the theme's ink for it. Several used to wear a colour each (a teal,
 * a flat four-stop gradient, an indigo, an amber, a red) that nobody had
 * chosen but us, which made the row legible and every mark on it a little
 * wrong. `session-new.css` tints the launcher tiles to match, and the two
 * must agree: a black mark on a purple tile still says purple.
 *
 * Monochrome mode swaps every fill for `currentColor`.
 */

import { For, type JSX } from "solid-js"
import { initialOf } from "./marks"
import { ANTIGRAVITY_ARCH, ANTIGRAVITY_BLOBS, CODEX_GRADIENT, CODEX_PATH, NOUS_PATHS } from "./vendor-paths"

/**
 * What a black-and-white mark is painted with.
 *
 * Pure black and pure white rather than the theme's text colour: these are
 * the vendors' own values, and a logo does not soften to match the copy
 * beside it.
 */
const INK = "light-dark(#000000, #FFFFFF)"

export interface AgentMarkProps {
  /** The agent id from `agents.ts`. */
  id: string
  /**
   * Rendered size in px.
   *
   * Most marks are square and take it as both dimensions. nikcli's and
   * OpenCode's are 4:5 and take it as their height; OhMyPi's is 4:3 and takes
   * it as its width, so a wide mark cannot push a row apart.
   */
  size?: number
  /** Whether to render authentic full brand colors. Defaults to true. */
  colored?: boolean
}

export function AgentMark(props: AgentMarkProps): JSX.Element {
  const size = () => props.size ?? 18
  const colored = () => props.colored !== false
  const draw = MARKS[props.id]
  if (draw) return draw(size, colored)
  return <Monogram letter={initialOf(props.id)} size={size()} colored={colored()} />
}

/**
 * The marks, by agent id.
 *
 * A function of the size and color mode rather than a static node so one component can be
 * drawn at 18px in the launcher and at 14px in a pane header without a second
 * copy of the geometry.
 */
const MARKS: Record<string, (size: () => number, colored: () => boolean) => JSX.Element> = {
  /* Anthropic's Claude mark */
  "claude-code": (size, colored) => (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={colored() ? "#D97757" : "currentColor"}
      aria-hidden="true"
      data-mark="claude-code"
    >
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  ),

  /*
   * OpenAI Codex: the rosette's silhouette with a `>_` prompt cut out, in
   * the lilac-to-blue gradient of the app icon.
   *
   * Not OpenAI's teal: `#10A37F` was the API-era colour, retired with the
   * rebrand, and it named the company rather than the product. The gradient
   * runs top to bottom in user space so it lands the same at any size.
   */
  codex: (size, colored) => (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={colored() ? "url(#ade-codex-grad)" : "currentColor"}
      fill-rule="evenodd"
      aria-hidden="true"
      data-mark="codex"
    >
      {colored() && (
        <defs>
          <linearGradient id="ade-codex-grad" gradientUnits="userSpaceOnUse" x1="12" y1="0" x2="12" y2="24">
            <For each={CODEX_GRADIENT}>{(stop) => <stop offset={stop.offset} stop-color={stop.color} />}</For>
          </linearGradient>
        </defs>
      )}
      <path clip-rule="evenodd" d={CODEX_PATH} />
    </svg>
  ),

  /*
   * OpenCode's block ring.
   *
   * The identity file paints the ring `#F1ECEC`, an off-white made for the
   * dark ground it ships on; on the light theme that is a ring the colour of
   * the page, and the mark collapsed to its grey block. The light value is
   * the one `session-new.css` already used for the tile, so the two agree.
   */
  opencode: (size, colored) => {
    const height = size()
    return (
      <svg width={(height * 256) / 320} height={height} viewBox="0 0 256 320" aria-hidden="true" data-mark="opencode">
        <path
          fill-rule="evenodd"
          d="M256 320H0V0h256zM192 64H64v192h128z"
          fill={colored() ? "light-dark(#18181B, #F1ECEC)" : "currentColor"}
        />
        <path
          d="M192 128v128H64V128z"
          fill={colored() ? "#71717A" : "currentColor"}
          opacity={colored() ? "1" : "0.3"}
        />
      </svg>
    )
  },

  /*
   * Google Antigravity's arch, cut from a field of blurred colour.
   *
   * That is the app icon: not a flat arch and not a linear gradient, but
   * eleven soft blobs of Google's yellow, red, green and blue behind a mask
   * shaped like the arch. The four-stop gradient it wore before was a guess
   * at this from memory; the blobs, their blur radii and the mask are the
   * vendor's. Monochrome mode draws the arch alone in `currentColor`.
   *
   * The ids repeat wherever the mark is drawn twice on one page; every copy
   * defines them identically, so whichever wins is the right one.
   */
  agy: (size, colored) => (
    <svg width={size()} height={size()} viewBox="0 0 24 24" aria-hidden="true" data-mark="agy">
      {colored() ? (
        <>
          <defs>
            <mask id="ade-agy-mask" maskUnits="userSpaceOnUse" x="0" y="1" width="24" height="23">
              <path d={ANTIGRAVITY_ARCH} fill="#fff" />
            </mask>
            <For each={ANTIGRAVITY_BLOBS}>
              {(blob, i) => (
                <filter
                  id={`ade-agy-blur-${i()}`}
                  filterUnits="userSpaceOnUse"
                  color-interpolation-filters="sRGB"
                  x={blob.region.x}
                  y={blob.region.y}
                  width={blob.region.w}
                  height={blob.region.h}
                >
                  <feGaussianBlur stdDeviation={blob.blur} />
                </filter>
              )}
            </For>
          </defs>
          <g mask="url(#ade-agy-mask)">
            <For each={ANTIGRAVITY_BLOBS}>
              {(blob, i) => (
                <g filter={`url(#ade-agy-blur-${i()})`}>
                  <path d={blob.d} fill={blob.fill} />
                </g>
              )}
            </For>
          </g>
        </>
      ) : (
        <path d={ANTIGRAVITY_ARCH} fill="currentColor" />
      )}
    </svg>
  ),

  /*
   * Moonshot Kimi's K.
   *
   * The dot is the brand's one colour, `#1783FF`; the K is ink. They had
   * been swapped around — a cyan dot from nowhere, and the K in the dot's
   * blue.
   */
  kimi: (size, colored) => (
    <svg width={size()} height={size()} viewBox="0 0 24 24" aria-hidden="true" data-mark="kimi">
      <path
        fill={colored() ? "#1783FF" : "currentColor"}
        d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35"
      />
      <path
        fill={colored() ? INK : "currentColor"}
        d="M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441"
      />
    </svg>
  ),

  /*
   * Prime Intellect's butterfly, in ink — the file it comes from paints it
   * `#ffffff`, and the indigo gradient it wore here was ours.
   */
  prime: (size, colored) => (
    <svg width={size()} height={size()} viewBox="0 0 178 178" aria-hidden="true" data-mark="prime">
      <path
        fill={colored() ? INK : "currentColor"}
        d="m 123.322,84.092671 c -0.192,0.0065 -0.43,0.0147 -0.74,0.0147 l -0.018,-0.0247 c -0.873,0.1977 -1.958,0.1266 -3.067,0.0537 -3.29,-0.216 -6.799,-0.4465 -5.635,6.2824 0.259,1.4822 -1.538,1.8465 -2.73,1.9082 -3.384,0.1853 -6.78,0.2594 -10.171,0.1915 -0.641,-0.0106 -1.2979,-0.5506 -1.8904,-1.0388 -0.1022,-0.0844 -0.2034,-0.1673 -0.3016,-0.2457 -0.1052,-0.0865 0.2898,-1.2042 0.4942,-1.2166 3.3078,-0.1931 4.5068,-2.4361 5.7028,-4.6724 0.603,-1.1253 1.204,-2.2488 2.072,-3.1088 7.856,-7.7874 15.878,-15.4265 25.054,-21.7008 0.895,-0.6114 1.989,-1.1733 2.73,-0.1111 0.571,0.8205 0.036,1.2854 -0.512,1.7627 -0.24,0.2088 -0.482,0.4199 -0.637,0.6642 -0.554,0.8792 -1.538,1.5273 -2.514,2.1717 -1.92,1.2655 -3.82,2.5172 -2.408,5.4798 1.225,2.5651 0.129,3.0202 -1.555,3.7198 l -0.069,0.0287 c -0.72,0.3021 -1.458,0.5764 -2.194,0.8506 -1.568,0.5835 -3.134,1.1662 -4.537,2.0149 -1.408,0.8522 -2.081,2.5134 0.222,3.4954 5.033,2.1428 18.064,-1.2784 20.608,-5.9965 2.377,-4.4147 5.931,-7.6891 9.481,-10.9611 1.992,-1.836 3.984,-3.6712 5.767,-5.7067 3.844,-4.3849 8.344,-8.1939 12.846,-12.005 2.239,-1.8944 4.478,-3.78938 6.637,-5.75588 1.624,-1.48207 2.297,-3.43353 1.026,-5.56412 -1.267,-2.118215 -3.416,-2.402287 -5.435,-1.926802 -13.309,3.130982 -26.166,7.355122 -37.585,15.241302 -18.23,12.5919 -36.4911,25.1406 -54.9002,37.4669 -6.2743,4.2056 -10.0723,2.1491 -12.1657,-5.1318 -4.6502,-16.1676 -11.4681,-30.2664 -31.0569,-32.4587 -7.1574,-0.8028 -12.4066,3.6807 -11.3692,10.7949 0.5249,3.6065 0.0495,7.003 -1.6858,10.3872 -0.3827,0.7472 -0.7689,1.4947 -1.1556,2.243 -2.672,5.1706 -5.3671,10.3857 -7.0394,15.8885 -0.1399,0.4602 -0.3002,0.9444 -0.4654,1.4437 -1.4909,4.5052 -3.3862,10.2323 5.659,10.5492 0.3705,0.0123 1.0808,0.944799 0.9943,1.290699 -0.1976,0.8213 -0.5991,1.797 -1.2413,2.2725 -8.6705,6.3917 -15.79706,14.1294 -18.860151,24.5971 -1.550066,5.2865 -0.524909,10.7765 3.989391,14.8705 3.22984,2.928 7.35516,4.625 10.97396,2.162 3.3009,-2.247 6.9232,-3.754 10.538,-5.259 3.1819,-1.324 6.358,-2.646 9.3041,-4.468 0.7101,-0.439 1.5727,-0.841 2.4456,-1.248 2.4138,-1.1228 4.9063,-2.2843 4.4709,-4.3841 -0.6854,-3.2908 -4.1623,-6.3418 -7.0586,-8.7384 -2.8716,-2.3769 -10.1897,-18.3411 -9.3189,-22.176099 1.2193,-5.3704 3.9645,-10.0201 6.7125,-14.6744 2.3458,-3.9731 4.6935,-7.9497 6.0956,-12.3806 0.5804,-1.828 2.8037,-2.8284 4.9466,-2.0997 1.4543,0.4928 1.2068,1.8278 0.9762,3.0715 -0.0063,0.0344 -0.0127,0.0685 -0.019,0.1027 -0.8688,4.7802 -1.721,9.566 -2.5733,14.3517 -0.4261,2.3924 -0.8521,4.7847 -1.2803,7.1762 -0.2717,1.5316 0.2038,2.7544 1.7909,3.0631 3.0569,0.599 2.989,1.9762 1.6119,4.341499 -1.4636,2.5072 -1.6674,5.5703 -0.0309,7.8861 1.6427,2.3282 4.3908,2.8161 7.1821,1.4204 1.7415,-0.8646 3.094,-0.0927 3.0755,1.6612 -0.1112,9.3688 3.8103,7.2561 8.584,3.1681 0.439,-0.3763 1.0373,-0.5846 1.6152,-0.7857 0.1048,-0.0366 0.2091,-0.0728 0.3116,-0.1098 0.4529,-0.1616 0.9062,-0.3224 1.3595,-0.4833 8.986,-3.1884 17.9603,-6.3725 23.0334,-15.573099 0.392,-0.7187 1.6783,-1.0669 2.6795,-1.3377 0.057,-0.0154 0.113,-0.0307 0.1681,-0.0456 5.8013,-1.5766 11.7248,-1.6001 17.6438,-1.6237 4.445,-0.0176 8.888,-0.0352 13.277,-0.7107 4.329,-0.667 9.047,-3.1928 9.084,-7.3736 0.035,-3.3707 -2.546,-3.1612 -5.123,-2.9519 -1.115,0.0906 -2.231,0.1811 -3.134,-0.0185 -0.182,-0.0381 -0.375,-0.0316 -0.686,-0.0209 z"
      />
      <path
        fill={colored() ? INK : "currentColor"}
        d="m 55.1325,131.29447 c -1.0745,7.1515 1.6551,13.2715 12.8266,13.1915 h -0.0062 c 9.5413,-0.389 20.3365,-6.164 30.8838,-13.5492 6.9653,-4.8787 12.9873,-10.0236 16.8903,-17.6253 2.872,-5.5889 1.395,-10.0723 -2.933,-13.993799 -1.908,-1.7291 -3.73,-1.9205 -5.867,0.1667 -7.5842,7.423099 -17.0261,11.474299 -26.7218,15.550099 -2.4706,1.0393 -5.2847,1.5582 -8.1187,2.0809 -7.5511,1.3924 -15.2431,2.8103 -16.954,14.1791 z"
      />
    </svg>
  ),

  /*
   * pi's blocky P. `logo-auto.svg` is black, and white under a dark scheme,
   * and both squares are the one colour: the two ambers here were invented,
   * and so was the difference between them.
   */
  pi: (size, colored) => (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={colored() ? INK : "currentColor"}
      aria-hidden="true"
      data-mark="pi"
    >
      <path fill-rule="evenodd" d="M0 0h18v12h-6v6H6v6H0Zm6 6v6h6V6Z" />
      <path d="M18 12h6v12h-6z" />
    </svg>
  ),

  /*
   * Oh My Pi: π with a plug, as `assets/icon.svg` draws it.
   *
   * The icon is made for a dark ground — bars `#fafafa`, plug `#f97316`,
   * prongs `#0d0d0d` — so the bars take ink to survive the light theme, and
   * the prongs stay dark because they sit on the orange, not the ground. The
   * two dots on the bar are the vendor's; they had been left off.
   */
  ohmypi: (size, colored) => {
    const width = size()
    const bar = colored() ? "light-dark(#0D0D0D, #FAFAFA)" : "currentColor"
    return (
      <svg width={width} height={(width * 90) / 120} viewBox="0 0 120 90" aria-hidden="true" data-mark="ohmypi">
        <rect x="10" y="8" width="100" height="12" rx="2" fill={bar} />
        <rect x="25" y="20" width="12" height="62" rx="2" fill={bar} />
        <rect x="75" y="20" width="12" height="45" rx="2" fill={bar} />
        <rect
          x="71"
          y="55"
          width="20"
          height="16"
          rx="3"
          fill={colored() ? "#F97316" : "currentColor"}
          opacity={colored() ? "1" : "0.45"}
        />
        <rect
          x="76"
          y="59"
          width="3"
          height="8"
          rx="1"
          fill={colored() ? "#0D0D0D" : "currentColor"}
          opacity={colored() ? "1" : "0"}
        />
        <rect
          x="82"
          y="59"
          width="3"
          height="8"
          rx="1"
          fill={colored() ? "#0D0D0D" : "currentColor"}
          opacity={colored() ? "1" : "0"}
        />
        <circle cx="18" cy="14" r="2" fill={colored() ? "#F97316" : "currentColor"} opacity="0.8" />
        <circle cx="102" cy="14" r="2" fill={colored() ? "#F97316" : "currentColor"} opacity="0.8" />
      </svg>
    )
  },

  /* nikcli block N */
  nikcli: (size, colored) => {
    const height = size()
    return (
      <svg width={(height * 240) / 300} height={height} viewBox="0 0 240 300" aria-hidden="true" data-mark="nikcli">
        <path
          d="M0 0H60V60H0ZM60 0H120V60H60ZM120 0H180V60H120ZM0 60H60V120H0ZM180 60H240V120H180ZM0 120H60V180H0ZM180 120H240V180H180ZM0 180H60V240H0ZM180 180H240V240H180ZM0 240H60V300H0ZM180 240H240V300H180Z"
          fill={colored() ? "light-dark(#211E1E, #F1ECEC)" : "currentColor"}
        />
        <path
          d="M60 120H120V180H60ZM120 120H180V180H120ZM60 180H120V240H60ZM120 180H180V240H120ZM60 240H120V300H60ZM120 240H180V300H120Z"
          fill={colored() ? "light-dark(#CFCECD, #4B4646)" : "currentColor"}
          opacity={colored() ? "1" : "0.3"}
        />
      </svg>
    )
  },

  /*
   * Nous Research's profile portrait, which is what Hermes ships under.
   *
   * Black and white is the brand — their booklet gives no second colour — so
   * colored mode is the theme's ink, same as Codex. The ring-and-wordmark
   * that was here had a red that belonged to nobody.
   */
  hermes: (size, colored) => (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={colored() ? INK : "currentColor"}
      fill-rule="evenodd"
      aria-hidden="true"
      data-mark="hermes"
    >
      <path d={NOUS_PATHS.eyeA} />
      <path d={NOUS_PATHS.eyeB} />
      <path clip-rule="evenodd" d={NOUS_PATHS.figure} />
    </svg>
  ),

  /* Terminal desktop console */
  terminal: (size, colored) => (
    <svg width={size()} height={size()} viewBox="0 0 24 24" aria-hidden="true" data-mark="terminal">
      <rect
        x="2.5"
        y="4"
        width="19"
        height="16"
        rx="2.4"
        fill={colored() ? "#0F172A" : "none"}
        stroke={colored() ? "#334155" : "currentColor"}
        stroke-width="1.4"
      />
      {colored() && (
        <>
          <circle cx="5.5" cy="7" r="1.1" fill="#EF4444" />
          <circle cx="8.5" cy="7" r="1.1" fill="#F59E0B" />
          <circle cx="11.5" cy="7" r="1.1" fill="#10B981" />
        </>
      )}
      <path
        d="M6.8 11.5l2.6 2.3-2.6 2.3M11.5 16.5h4"
        stroke={colored() ? "#22C55E" : "currentColor"}
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  ),
}

function Monogram(props: { letter: string; size: number; colored?: boolean }): JSX.Element {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 24 24" aria-hidden="true" data-mark="monogram">
      <circle
        cx="12"
        cy="12"
        r="9.6"
        fill={props.colored ? "rgba(239, 68, 68, 0.12)" : "none"}
        stroke={props.colored ? "#EF4444" : "currentColor"}
        stroke-width="1.4"
        opacity={props.colored ? 1 : 0.55}
      />
      <text
        x="12"
        y="12.5"
        text-anchor="middle"
        dominant-baseline="central"
        fill={props.colored ? "#EF4444" : "currentColor"}
        font-family="var(--ade-sans, system-ui)"
        font-size="11"
        font-weight="700"
      >
        {props.letter}
      </text>
    </svg>
  )
}
