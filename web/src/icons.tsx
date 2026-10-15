import type { ReactNode } from 'react';

type Props = { size?: number };

function Icon({ size = 20, children }: Props & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const User = (p: Props) => (
  <Icon {...p}>
    <circle cx="10.5" cy="7" r="3.5" />
    <path d="M3.5 18.5c0-3.9 3.1-6 7-6s7 2.1 7 6" />
  </Icon>
);

export const Check = (p: Props) => (
  <Icon {...p}>
    <path d="m5.5 11 3.5 3.5 7-8" />
  </Icon>
);

export const CheckCircle = (p: Props) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="8" />
    <path d="m7 10.75 2.5 2.5 4.5-5" />
  </Icon>
);

export const Clock = (p: Props) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="8" />
    <path d="M10.5 6v4.5H14" />
  </Icon>
);

export const Trash = (p: Props) => (
  <Icon {...p}>
    <path d="M3.5 5.5h14M8 5.5v-1A1.5 1.5 0 0 1 9.5 3h2A1.5 1.5 0 0 1 13 4.5v1" />
    <path d="m5.5 5.5.75 11.25a1.5 1.5 0 0 0 1.5 1.25h5.5a1.5 1.5 0 0 0 1.5-1.25l.75-11.25M8.75 8.5V15m3.5-6.5V15" />
  </Icon>
);

export const ChevronDown = (p: Props) => (
  <Icon {...p}>
    <path d="m6.5 8.5 4 4 4-4" />
  </Icon>
);

export const Plus = (p: Props) => (
  <Icon {...p}>
    <path d="M10.5 5v11M5 10.5h11" />
  </Icon>
);

export const Refresh = (p: Props) => (
  <Icon {...p}>
    <path d="M18.75 4.5V9h-4.5" />
    <path d="M16.87 12.75a6.75 6.75 0 1 1-1.59-7.02L18.75 9" />
  </Icon>
);

export const Coffee = (p: Props) => (
  <Icon {...p}>
    <path d="M4 8.5h10v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zm10 1h1a2 2 0 0 1 0 4h-1.3M7.5 3.5V6m3-2.5V6" />
  </Icon>
);

export const Download = (p: Props) => (
  <Icon {...p}>
    <path d="M10.5 3.5v10m-4-4 4 4 4-4m-10 7.5h12" />
  </Icon>
);

export const Lock = (p: Props) => (
  <Icon {...p}>
    <rect x="4.5" y="9.5" width="12" height="9" rx="2" />
    <path d="M7.5 9.5v-3a3 3 0 0 1 6 0v3" />
    <circle cx="10.5" cy="14" r="1" />
  </Icon>
);

export const External = (p: Props) => (
  <Icon {...p}>
    <path d="M16.5 12v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H9m3.5-1h5v5m0-5L10 11" />
  </Icon>
);

export const Pencil = (p: Props) => (
  <Icon {...p}>
    <path d="M13.5 4.5 16.5 7.5 8 16H5v-3l8.5-8.5zm-2 2 3 3" />
  </Icon>
);

export const History = (p: Props) => (
  <Icon {...p}>
    <path d="M3.75 10.5a6.75 6.75 0 1 0 6.75-6.75 7.3 7.3 0 0 0-5.05 2.05L3.75 7.5m0-3.75V7.5H7.5m3-.75v3.75l3 1.5" />
  </Icon>
);

export const Info = (p: Props) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="8" />
    <path d="M10.5 9.5v5m0-8v.01" />
  </Icon>
);

export const XCircle = (p: Props) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="8" />
    <path d="m7.5 7.5 6 6m0-6-6 6" />
  </Icon>
);

export const Logo = (p: Props) => (
  <Icon {...p}>
    <g transform="rotate(8 10.5 10.5)">
      <rect x="3.5" y="1.5" width="14" height="18" rx="3" fill="#4b9ae8" stroke="none" />
      <path d="m7 10.75 2.5 2.5 4.5-5" stroke="#fff" strokeWidth={2} />
    </g>
  </Icon>
);
