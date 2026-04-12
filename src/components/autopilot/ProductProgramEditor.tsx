'use client';

import { useState } from 'react';
import { Save, RefreshCw } from 'lucide-react';
import type { Product } from '@/lib/types';

interface ProductProgramEditorProps {
  product: Product;
  onSave: (product: Product) => void;
}

export function ProductProgramEditor({ product, onSave }: ProductProgramEditorProps) {
  const [program, setProgram] = useState(product.product_program || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const currentSha = product.current_product_program_sha || '';
  const lastCanonicalSha = product.last_canonical_program_sha || '';
  const syncState = !product.canonical_program_path
    ? { label: 'Canonical path missing', tone: 'text-red-400 border-red-500/30 bg-red-500/10' }
    : !product.last_program_audit_at
    ? { label: 'Not audited yet', tone: 'text-amber-300 border-amber-500/30 bg-amber-500/10' }
    : lastCanonicalSha && currentSha === lastCanonicalSha
    ? { label: 'Repo and DB in sync', tone: 'text-green-400 border-green-500/30 bg-green-500/10' }
    : { label: 'Repo and DB may differ', tone: 'text-amber-300 border-amber-500/30 bg-amber-500/10' };
  const researchMatches = product.last_research_program_sha
    ? product.last_research_program_sha === currentSha
    : null;
  const ideationMatches = product.last_ideation_program_sha
    ? product.last_ideation_program_sha === currentSha
    : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_program: program }),
      });
      if (res.ok) {
        const updated = await res.json();
        onSave(updated);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (error) {
      console.error('Failed to save program:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    if (!product.canonical_program_path) {
      alert('Please set a Canonical Program Path in Product Settings (the gear icon) first.');
      return;
    }
    setSyncing(true);
    try {
      const res = await fetch(`/api/products/${product.id}/sync-program`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setProgram(data.product_program);
        onSave(data);
      } else {
        const err = await res.json();
        alert(`Sync failed: ${err.error}`);
      }
    } catch (error) {
      console.error('Failed to sync program:', error);
      alert('Network error while syncing');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border px-4 py-3 text-sm ${syncState.tone}`}>
        <div className="font-medium">{syncState.label}</div>
        <div className="mt-2 space-y-1 text-xs text-mc-text-secondary">
          <p>Canonical path: {product.canonical_program_path || 'Set this in Product Settings first.'}</p>
          <p>Current DB SHA: {currentSha || 'Unavailable'}</p>
          <p>Last canonical SHA: {lastCanonicalSha || 'Unavailable'}</p>
          <p>Last audit: {product.last_program_audit_at ? new Date(product.last_program_audit_at).toLocaleString() : 'Never'}</p>
          <p>Last research SHA: {product.last_research_program_sha || 'No recorded research provenance yet'}</p>
          <p>Last ideation SHA: {product.last_ideation_program_sha || 'No recorded ideation provenance yet'}</p>
          {researchMatches !== null && (
            <p>Research provenance: {researchMatches ? 'matches current DB copy' : 'stale against current DB copy'}</p>
          )}
          {ideationMatches !== null && (
            <p>Ideation provenance: {ideationMatches ? 'matches current DB copy' : 'stale against current DB copy'}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-mc-text">Product Program</h3>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSync}
            disabled={syncing || saving}
            className="min-h-11 px-4 rounded-lg bg-mc-bg-tertiary border border-mc-border text-mc-text-secondary hover:text-mc-text disabled:opacity-50 flex items-center gap-2 text-sm title-tooltip"
            title={product.canonical_program_path ? `Audit repo file and sync from ${product.canonical_program_path}` : 'Set Canonical Program Path in settings first'}
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Audit & Sync'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || syncing}
            className="min-h-11 px-4 rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 disabled:opacity-50 flex items-center gap-2 text-sm"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>
      <textarea
        value={program}
        onChange={e => setProgram(e.target.value)}
        className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text font-mono text-sm focus:outline-none focus:border-mc-accent resize-none min-h-[600px]"
        placeholder="Write your product program here..."
      />
    </div>
  );
}
