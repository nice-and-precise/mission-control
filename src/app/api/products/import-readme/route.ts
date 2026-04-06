import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { repo_url } = await request.json();

    if (!repo_url) {
      return NextResponse.json({ error: 'repo_url is required' }, { status: 400 });
    }

    // Extract owner/repo from GitHub URL
    const match = repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) {
      return NextResponse.json({ error: 'Only GitHub repositories are supported' }, { status: 400 });
    }

    const [, owner, repo] = match;

    // Try GitHub API first (works for public repos)
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: {
          'Accept': 'application/vnd.github.raw+json',
          'User-Agent': 'Autensa/2.0',
        },
      });

      if (res.ok) {
        const readme = await res.text();
        return NextResponse.json({ readme });
      }
    } catch {
      // GitHub API failed — private repo or network error
    }

    return NextResponse.json(
      { error: 'Could not fetch README.md — repo may be private and not found locally. Clone the repo first.' },
      { status: 404 }
    );
  } catch (error) {
    console.error('Import README failed:', error);
    return NextResponse.json({ error: 'Failed to import README' }, { status: 500 });
  }
}
