import { auth } from "@/lib/auth/server";

export default auth.middleware({ loginUrl: "/auth/sign-in" });

export const config = {
  // Protected routes — add more as the app grows
  matcher: ["/account/:path*", "/dashboard/:path*", "/onboarding/:path*", "/eval/:path*"],
};
