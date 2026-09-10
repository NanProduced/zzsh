import horizontalLogo from "@brand/zzsh-logo-variant-05.png";
import squareLogo from "@brand/zzsh-logo-variant-01.png";
import markLogo from "@brand/zzsh-logo-variant-04.png";

type BrandLogoProps = {
  variant?: "horizontal" | "square" | "mark";
  className?: string;
  height?: number;
  alt?: string;
};

export function BrandLogo({
  variant = "horizontal",
  className = "",
  height = 36,
  alt = "洲洲商行",
}: BrandLogoProps) {
  const src =
    variant === "horizontal"
      ? horizontalLogo
      : variant === "square"
      ? squareLogo
      : markLogo;

  return (
    <img
      src={src}
      alt={alt}
      height={height}
      style={{ height: `${height}px`, width: "auto" }}
      className={`brand-logo-img object-contain select-none ${className}`}
      loading="eager"
      decoding="async"
    />
  );
}
