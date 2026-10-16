import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

let clicks = 0;

async function click() {
  'use server';
  // Server actions compare Origin and Host; localcloud rewrites both to localhost, so this passes
  // without `serverActions.allowedOrigins` or `allowedDevOrigins`.
  clicks += 1;
  revalidatePath('/');
}

export default async function Page() {
  const h = await headers();
  return (
    <main>
      <h1>Hello from a tunnel 👋</h1>
      <p>
        Public URL: <code>{h.get('x-localcloud-url') || '(not tunnelled)'}</code>
        <br />
        Next.js sees host: <code>{h.get('host')}</code>
      </p>
      <p>Edit <code>app/page.js</code> and save — Fast Refresh updates this page through the tunnel.</p>
      <form action={click}>
        <button type="submit">server action clicked {clicks} times</button>
      </form>
    </main>
  );
}
