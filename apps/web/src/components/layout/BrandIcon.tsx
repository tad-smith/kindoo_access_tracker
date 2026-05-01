// Brand-bar icon. Sits left of the wordmark in the topbar. Uses the
// public favicon SVG so the hero icon, favicon, and manifest icons
// share one source asset.

interface BrandIconProps {
  size?: number;
  alt?: string;
}

export function BrandIcon({ size = 28, alt = '' }: BrandIconProps) {
  return (
    <img
      src="/favicon.svg"
      alt={alt}
      aria-hidden={alt === '' ? true : undefined}
      width={size}
      height={size}
      className="kd-brand-icon"
    />
  );
}
