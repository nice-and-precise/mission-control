/**
 * DeliverablesList Component
 * Displays deliverables (files, URLs, artifacts) for a task
 */

'use client';

import { useEffect, useState } from 'react';
import { FileText, Link as LinkIcon, Package, ExternalLink } from 'lucide-react';
import type { TaskDeliverable } from '@/lib/types';

interface DeliverablesListProps {
  taskId: string;
}

export function DeliverablesList({ taskId }: DeliverablesListProps) {
  const [deliverables, setDeliverables] = useState<TaskDeliverable[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDeliverables();
  }, [taskId]);

  const loadDeliverables = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/deliverables`);
      if (res.ok) {
        const data = await res.json();
        setDeliverables(data);
      }
    } catch (error) {
      console.error('Failed to load deliverables:', error);
    } finally {
      setLoading(false);
    }
  };

  const getDeliverableIcon = (type: string) => {
    switch (type) {
      case 'file':
        return <FileText className="w-5 h-5" />;
      case 'url':
        return <LinkIcon className="w-5 h-5" />;
      case 'artifact':
        return <Package className="w-5 h-5" />;
      default:
        return <FileText className="w-5 h-5" />;
    }
  };

  const handleOpen = (deliverable: TaskDeliverable) => {
    if (deliverable.deliverable_type === 'url' && deliverable.path) {
      window.open(deliverable.path, '_blank');
    } else if (deliverable.path) {
      // For files, we could trigger a download or open in a viewer
      console.log('Open file:', deliverable.path);
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading deliverables...</div>
      </div>
    );
  }

  if (deliverables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <div className="text-4xl mb-2">📦</div>
        <p>No deliverables yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {deliverables.map((deliverable) => (
        <div
          key={deliverable.id}
          className="flex gap-3 p-3 bg-mc-bg rounded-lg border border-mc-border hover:border-mc-accent transition-colors"
        >
          {/* Icon */}
          <div className="flex-shrink-0 text-mc-accent">
            {getDeliverableIcon(deliverable.deliverable_type)}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Title */}
            <div className="flex items-start justify-between gap-2">
              <h4 className="font-medium text-mc-text">{deliverable.title}</h4>
              {deliverable.path && (
                <button
                  onClick={() => handleOpen(deliverable)}
                  className="flex-shrink-0 p-1 hover:bg-mc-bg-tertiary rounded text-mc-accent"
                  title="Open"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Description */}
            {deliverable.description && (
              <p className="text-sm text-mc-text-secondary mt-1">
                {deliverable.description}
              </p>
            )}

            {/* Path */}
            {deliverable.path && (
              <div className="mt-2 p-2 bg-mc-bg-tertiary rounded text-xs text-mc-text-secondary font-mono break-all">
                {deliverable.path}
              </div>
            )}

            {/* Metadata */}
            <div className="flex items-center gap-4 mt-2 text-xs text-mc-text-secondary">
              <span className="capitalize">{deliverable.deliverable_type}</span>
              <span>•</span>
              <span>{formatTimestamp(deliverable.created_at)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
