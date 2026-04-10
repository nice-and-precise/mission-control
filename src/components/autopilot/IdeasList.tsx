'use client';

import { useState, useEffect, useCallback } from 'react';
import { IdeaCard } from './IdeaCard';
import type { Idea } from '@/lib/types';

interface IdeasListProps {
  productId: string;
}

export function IdeasList({ productId }: IdeasListProps) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const loadIdeas = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }

    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      const res = await fetch(`/api/products/${productId}/ideas?${params}`);
      if (res.ok) setIdeas(await res.json());
    } catch (error) {
      console.error('Failed to load ideas:', error);
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [categoryFilter, productId, statusFilter]);

  useEffect(() => {
    loadIdeas();
  }, [loadIdeas]);

  useEffect(() => {
    const es = new EventSource('/api/events/stream');

    es.onmessage = (event) => {
      try {
        if (event.data.startsWith(':')) return;
        const sseEvent = JSON.parse(event.data) as { type?: string; payload?: { productId?: string } };
        if (sseEvent.payload?.productId !== productId) return;

        if (
          sseEvent.type === 'ideas_generated'
          || sseEvent.type === 'idea_swiped'
          || sseEvent.type === 'maybe_resurfaced'
          || sseEvent.type === 'idea_building'
          || sseEvent.type === 'idea_shipped'
        ) {
          loadIdeas({ silent: true });
        }
      } catch {
        // ignore malformed SSE payloads
      }
    };

    return () => es.close();
  }, [loadIdeas, productId]);

  const statuses = ['', 'pending', 'approved', 'rejected', 'maybe', 'building', 'built', 'shipped'];
  const categories = ['', 'content', 'compliance', 'operations', 'improvement', 'feature', 'ux', 'performance', 'integration', 'infrastructure', 'growth', 'monetization', 'security'];

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text"
        >
          {statuses.map(s => (
            <option key={s} value={s}>{s || 'All statuses'}</option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text"
        >
          {categories.map(c => (
            <option key={c} value={c}>{c || 'All categories'}</option>
          ))}
        </select>
        <span className="text-sm text-mc-text-secondary self-center">{ideas.length} ideas</span>
      </div>

      {loading ? (
        <div className="text-mc-text-secondary animate-pulse py-8 text-center">Loading ideas...</div>
      ) : ideas.length === 0 ? (
        <div className="text-center py-12 text-mc-text-secondary">No ideas found</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ideas.map(idea => (
            <IdeaCard key={idea.id} idea={idea} showActions={false} compact />
          ))}
        </div>
      )}
    </div>
  );
}
