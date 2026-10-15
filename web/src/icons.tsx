/**
 * The workbench icon set.
 *
 * A superset of the extension's set on the same 16-unit grid, so the two
 * surfaces read as one product. Kept as its own file rather than a shared
 * package entry because the web app builds independently.
 */

import type { JSX, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function QuillMark({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" {...rest}>
      <path
        d="M8 1.6c1.9 0 3.2.7 3.2 1.9 0 .2 0 .4-.1.6-.3 1-.5 2.1-.5 3.2 0 2.5-.9 4.8-2.6 6.3-1.7-1.5-2.6-3.8-2.6-6.3 0-1.1-.2-2.2-.5-3.2 0-.2-.1-.4-.1-.6C4.8 2.3 6.1 1.6 8 1.6Z"
        fill="currentColor"
      />
      <circle cx="8" cy="5" r="1.1" fill="var(--q-mark-counter, #fff)" />
      <path d="M7.85 6.2h.3v3.6h-.3z" fill="var(--q-mark-counter, #fff)" />
    </svg>
  );
}

export const Book = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M2.8 3.2h4a1.6 1.6 0 0 1 1.2.6 1.6 1.6 0 0 1 1.2-.6h4v9.4h-4a1.6 1.6 0 0 0-1.2.6 1.6 1.6 0 0 0-1.2-.6h-4V3.2Z" />
    <path d="M8 3.8v9.4" />
  </Svg>
);

export const Brain = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M6.2 2.6A2.4 2.4 0 0 0 3.8 5c0 .4.1.7.2 1a2.2 2.2 0 0 0 .3 4.2c.3.9 1.1 1.5 2.1 1.5.6 0 1.1-.2 1.5-.6V3.4c0-.5-.4-.8-.7-.8Z" />
    <path d="M9.8 2.6A2.4 2.4 0 0 1 12.2 5c0 .4-.1.7-.2 1a2.2 2.2 0 0 1-.3 4.2c-.3.9-1.1 1.5-2.1 1.5-.6 0-1.1-.2-1.5-.6" />
  </Svg>
);

export const Chart = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M2.6 13.4h10.8" />
    <path d="M4.6 13.4V8.2M7.6 13.4V3.6M10.6 13.4v-3.2" />
  </Svg>
);

export const Table = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect x="2.4" y="3" width="11.2" height="10" rx="1.6" />
    <path d="M2.4 6.4h11.2M6.6 6.4V13" />
  </Svg>
);

export const Sparkle = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M8 1.8 9.4 6 13.6 7.4 9.4 8.8 8 13l-1.4-4.2L2.4 7.4 6.6 6 8 1.8Z" />
  </Svg>
);

export const Settings = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.8v1.5M8 12.7v1.5M13.1 4.9l-1.3.8M4.2 10.3l-1.3.8M13.1 11.1l-1.3-.8M4.2 5.7l-1.3-.8" />
  </Svg>
);

export const Upload = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M13 9.6v2.2a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 11.8V9.6" />
    <path d="M8 10.4V2.6M5 5.6 8 2.6l3 3" />
  </Svg>
);

export const Download = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M13 9.6v2.2a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 11.8V9.6" />
    <path d="M8 2.6v7.8M5 7.6 8 10.6l3-3" />
  </Svg>
);

export const Check = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="m3 8.5 3.2 3.2L13 4.8" />
  </Svg>
);

export const CheckCircle = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="m5.3 8.2 1.9 1.9 3.5-3.6" />
  </Svg>
);

export const X = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
  </Svg>
);

export const Plus = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);

export const Trash = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M2.8 4.4h10.4" />
    <path d="M6.2 4.4V3.2a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.2" />
    <path d="M3.9 4.4l.6 8.2a1.2 1.2 0 0 0 1.2 1.1h4.6a1.2 1.2 0 0 0 1.2-1.1l.6-8.2" />
    <path d="M6.6 7v4M9.4 7v4" />
  </Svg>
);

export const Lock = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect x="3.4" y="7" width="9.2" height="6.6" rx="1.6" />
    <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
  </Svg>
);

export const Info = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.2v4M8 5.1v.1" />
  </Svg>
);

export const Warning = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M7.1 2.9 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.9a1 1 0 0 0-1.8 0Z" />
    <path d="M8 6.4v3M8 11.4v.1" />
  </Svg>
);

export const Search = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="7.2" cy="7.2" r="4.6" />
    <path d="m10.6 10.6 2.6 2.6" />
  </Svg>
);

export const ChevronRight = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Svg>
);

export const ChevronDown = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="m3.5 6 4.5 4.5L12.5 6" />
  </Svg>
);

export const ArrowRight = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M2.8 8h10.4M9.2 4l4 4-4 4" />
  </Svg>
);

export const Clock = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.6V8l2.4 1.6" />
  </Svg>
);

export const Copy = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.6" />
    <path d="M10.4 5.6V4.2a1.6 1.6 0 0 0-1.6-1.6H4.2a1.6 1.6 0 0 0-1.6 1.6v4.6a1.6 1.6 0 0 0 1.6 1.6h1.4" />
  </Svg>
);

export const External = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M9.4 2.6H13.4v4" />
    <path d="M13.4 2.6 7.6 8.4" />
    <path d="M11.6 9.4v3.2a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.6V5.8a1.4 1.4 0 0 1 1.4-1.4h3.2" />
  </Svg>
);

export const Document = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M9 1.8H4.6a1.4 1.4 0 0 0-1.4 1.4v9.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V5.4L9 1.8Z" />
    <path d="M9 1.8v3.6h3.8" />
  </Svg>
);

export const Compass = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="m10.4 5.6-1.5 3.3-3.3 1.5 1.5-3.3 3.3-1.5Z" />
  </Svg>
);

export const Question = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.3 6.1a1.8 1.8 0 0 1 3.5.6c0 1.2-1.8 1.5-1.8 2.6" />
    <path d="M8 11.9v.1" />
  </Svg>
);

export const Eye = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M1.6 8S3.9 4.2 8 4.2 14.4 8 14.4 8 12.1 11.8 8 11.8 1.6 8 1.6 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </Svg>
);
