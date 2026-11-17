import Image from "next/image";
import Link from "next/link";

/** The Scout logo (binoculars + wordmark), linking home or to the dashboard */
export function Logo({ href = "/", height = 30, className }: { href?: string; height?: number; className?: string }) {
  return (
    <Link href={href} className={className ? `brand ${className}` : "brand"}>
      {/* logo-full.png is 800×184 */}
      <Image src="/logo-full.png" alt="Scout" width={Math.round((height * 800) / 184)} height={height} priority />
    </Link>
  );
}
