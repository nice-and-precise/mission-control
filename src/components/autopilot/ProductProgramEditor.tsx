'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader, RefreshCw, Save } from 'lucide-react';
import type { Product, ProductProgramDriftSummary } from '@/lib/types';

interface ProductProgramEditorProps {
  product: Product;
  onSave: (product: Product) => void;
}

export function ProductProgramEditor({ product, onSave }: ProductProgramEditorProps) {
  const [program, setProgram] = useState(product.product_program || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [drift, setDrift] = useState<ProductProgramDriftSummary | null>(null);
  const [driftLoading, setDriftLoading] = useState(true);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditMessage, setAuditMessage] = useState<string | null>(null);

  useEffect(() => {
    setProgram(product.product_program || '');
  }, [product.product_program]);

  async function loadDriftStatus() {
    setDriftLoading(true);
    setDriftError(null);
    try {
      const res = await fetch(`/api/products/${product.id}/program/drift`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load Product Program status' }));
        throw new Error(err.error || 'Failed to load Product Program status');
      }
      setDrift(await res.json());
    } catch (error) {
      setDriftError(error instanceof Error ? error.message : 'Failed to load Product Program status');
    } finally {
      setDriftLoading(false);
    }
  }

  useEffect(() => {
    void loadDriftStatus();
  }, [product.id, product.updated_at]);

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
        setAuditMessage('Mission Control DB copy saved. If repo truth changed separately, run Audit & Sync Program before research or ideation.');
        void loadDriftStatus();
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (error) {
      console.error('Failed to save program:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleAuditSync = async () => {
    setAuditRunning(true);
    setAuditMessage(null);
    try {
      const res = await fetch(`/api/products/${product.id}/program/audit-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncOnDrift: true }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || 'Failed to audit/sync Product Program');
      }

      setAuditMessage(payload.synced
        ? 'Audit complete. Mission Control DB copy was synced from canonical squti PRODUCT_PROGRAM.md.'
        : 'Audit complete. No Product Program drift detected.');

      if (payload.synced) {
        const productRes = await fetch(`/api/products/${product.id}`);
        if (!productRes.ok) {
          throw new Error('Product Program synced, but failed to refresh product state');
        }
        onSave(await productRes.json());
      }

      void loadDriftStatus();
    } catch (error) {
      setAuditMessage(error instanceof Error ? error.message : 'Failed to audit/sync Product Program');
    } finally {
      setAuditRunning(false);
    }
  };

  const latestResearchMessage = drift?.latest_research
    ? drift.latest_research.matches_canonical_program
      ? 'Latest research used the current canonical Product Program.'
      : 'Latest research did not use the current canonical Product Program.'
    : null;
  const latestIdeationMessage = drift?.latest_ideation
    ? drift.latest_ideation.matches_canonical_program
      ? 'Latest ideation used the current canonical Product Program.'
      : 'Latest ideation did not use the current canonical Product Program.'
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-mc-text">Product Program</h3>
          <p className="mt-1 text-xs text-mc-text-secondary">
            Research and ideation run from Mission Control&apos;s DB copy. Use Audit & Sync Program to verify that DB truth still matches canonical squti repo truth before starting a new cycle.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleAuditSync}
            disabled={auditRunning}
            className="min-h-11 px-4 rounded-lg bg-mc-bg-tertiary border border-mc-border text-mc-text hover:border-mc-accent/50 disabled:opacity-50 flex items-center gap-2 text-sm"
          >
            {auditRunning ? <Loader className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {auditRunning ? 'Auditing...' : 'Audit & Sync Program'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="min-h-11 px-4 rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 disabled:opacity-50 flex items-center gap-2 text-sm"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>

      {driftLoading && (
        <div className="rounded-lg border border-mc-border bg-mc-bg-secondary px-4 py-3 text-sm text-mc-text-secondary flex items-center gap-2">
          <Loader className="w-4 h-4 animate-spin" />
          Checking Product Program sync status...
        </div>
      )}

      {driftError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {driftError}
        </div>
      )}

      {drift && !driftLoading && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${drift.drift_detected ? 'border-amber-500/30 bg-amber-500/10' : 'border-green-500/30 bg-green-500/10'}`}>
          <div className="flex items-start gap-3">
            {drift.drift_detected ? (
              <AlertTriangle className="mt-0.5 w-4 h-4 text-amber-300" />
            ) : (
              <CheckCircle className="mt-0.5 w-4 h-4 text-green-300" />
            )}
            <div className="space-y-2 text-mc-text">
              <p>{drift.message}</p>
              {drift.canonical_program_path && (
                <p className="text-xs text-mc-text-secondary">
                  Canonical path: {drift.canonical_program_path}
                </p>
              )}
              {latestResearchMessage && <p className="text-xs text-mc-text-secondary">{latestResearchMessage}</p>}
              {latestIdeationMessage && <p className="text-xs text-mc-text-secondary">{latestIdeationMessage}</p>}
              {drift.recent_completed_tasks.length > 0 && (
                <div className="text-xs text-mc-text-secondary">
                  <p className="mb-1">Recent completed cards checked during audit:</p>
                  <ul className="space-y-1">
                    {drift.recent_completed_tasks.slice(0, 5).map((task) => (
                      <li key={task.id}>• {task.title}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {auditMessage && (
        <div className="rounded-lg border border-mc-border bg-mc-bg-secondary px-4 py-3 text-sm text-mc-text">
          {auditMessage}
        </div>
      )}

      <textarea
        value={program}
        onChange={e => setProgram(e.target.value)}
        className="w-full bg-mc-bg-tertiary border border-mc-border rounded-lg px-4 py-3 text-mc-text font-mono text-sm focus:outline-none focus:border-mc-accent resize-none min-h-[600px]"
        placeholder="Write your product program here..."
      />
    </div>
  );
}
