/**
 * Technical stroke icons. Straight lines, 1px strokes, no rounded caps, no
 * lifestyle glyphs, no emoji — these read as schematic symbols, not app icons.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function Svg({ size = 14, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 12a6.5 6.5 0 1 1 13 0" />
    <path d="M8 12 11.5 6" />
    <path d="M1.5 12h13" />
  </Svg>
);

export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.5 14.5 5 8 8.5 1.5 5Z" />
    <path d="M1.5 8 8 11.5 14.5 8" />
    <path d="M1.5 11 8 14.5 14.5 11" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.5 13.5 3.5v5c0 3-2.4 5.3-5.5 6.5-3.1-1.2-5.5-3.5-5.5-6.5v-5Z" />
    <path d="M5.5 8 7.4 10 10.5 6" />
  </Svg>
);

export const IconPulse = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1 8.5h3.2L6 4l2.6 8L10.4 8.5H15" />
  </Svg>
);

export const IconLoop = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 6.5h9l-2.5-2.5M14 9.5H5l2.5 2.5" />
    <path d="M2 6.5V4M14 9.5V12" />
  </Svg>
);

export const IconWave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v5" />
    <path d="M5 3.5v9M11 3.5v9" />
    <path d="M2 6.5v3M14 6.5v3" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 8.5 6.2 12.2 13.5 4" />
  </Svg>
);

export const IconCross = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
  </Svg>
);

export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8h9" />
  </Svg>
);

export const IconHazard = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.5 15 14H1Z" />
    <path d="M8 6v4M8 11.8v.7" />
  </Svg>
);

export const IconPower = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.5v6" />
    <path d="M4.2 3.9a5.5 5.5 0 1 0 7.6 0" />
  </Svg>
);

export const IconArrow = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 8h11M9.5 4.5 13 8l-3.5 3.5" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7h9v7h-9Z" />
    <path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p} strokeWidth="1.2">
    <path d="M4 4 12 12M12 4 4 12" />
  </Svg>
);
