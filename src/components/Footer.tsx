import Link from "next/link";

export default function Footer({ className = "" }: { className?: string }) {
  const company = process.env.NEXT_PUBLIC_COMPANY_NAME ?? "Thinka Platforms LTD";
  const rc = process.env.NEXT_PUBLIC_COMPANY_RC ?? "";
  return (
    <footer className={`onside-footer shrink-0 ${className}`}>
      <span>
        © {new Date().getFullYear()} {company}
        {rc ? ` · RC ${rc}` : ""} · Onside
      </span>
      <span aria-hidden="true"> · </span>
      <Link href="/terms" className="hover:text-chalk">Terms</Link>
      <span aria-hidden="true"> · </span>
      <Link href="/privacy" className="hover:text-chalk">Privacy</Link>
      <span aria-hidden="true"> · </span>
      <span>18+ · Bet responsibly</span>
    </footer>
  );
}
