interface BrandLogoProps { className?: string; height?: number; showText?: boolean; alt?: string; }
export function BrandLogo({ className = "", height = 42, alt = "洲洲商行" }: BrandLogoProps) {
  return <img src="/brand/zzsh-logo-variant-05.png" alt={alt} className={`brand-logo ${className}`}
    width={height * 3} height={height} style={{ height, width: height * 3 }} />;
}
