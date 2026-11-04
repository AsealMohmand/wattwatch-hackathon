import { Compass } from "lucide-react";
import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div data-testid="page-notfound" className="flex flex-col items-center gap-3 py-20 text-center">
      <Compass size={28} strokeWidth={1.5} className="text-text-muted" />
      <p className="text-text">There's nothing at this address.</p>
      <Link to="/" className="text-sm text-trace hover:underline">
        Back to overview
      </Link>
    </div>
  );
}
