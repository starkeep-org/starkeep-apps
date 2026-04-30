"use client";

import dynamic from "next/dynamic";

const ErrorContent = dynamic(
  () =>
    Promise.resolve(function ErrorUI({
      reset,
    }: {
      reset: () => void;
    }) {
      return (
        <html>
          <body>
            <button onClick={reset}>Retry</button>
          </body>
        </html>
      );
    }),
  { ssr: false },
);

export default function GlobalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorContent {...props} />;
}
