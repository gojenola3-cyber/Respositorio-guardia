// Declaraciones mínimas para comprobar los tipos de las Edge Functions con
// tsc fuera de Deno. En ejecución se usan los tipos reales de Deno y de
// supabase-js; aquí el cliente se tipa de forma laxa a propósito.
declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}

declare module 'jsr:@supabase/supabase-js@2' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SupabaseClient = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createClient(url: string, key: string, options?: Record<string, unknown>): any;
}
