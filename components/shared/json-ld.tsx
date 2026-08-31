import { serializeJsonForScript } from '@/lib/security/json-script';

export function JsonLd({ data }: { data: object | object[] }) {
  const json = serializeJsonForScript(data);
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json }}
      suppressHydrationWarning
    />
  );
}
