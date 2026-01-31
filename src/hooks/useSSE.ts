/**
 * useSSE Hook
 * Establishes and maintains Server-Sent Events connection for real-time updates
 */

'use client';

import { useEffect, useRef } from 'react';
import { useMissionControl } from '@/lib/store';
import type { SSEEvent, Task, TaskActivity, TaskDeliverable } from '@/lib/types';

export function useSSE() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const { 
    updateTask, 
    addTask,
    setIsOnline,
  } = useMissionControl();

  useEffect(() => {
    let isConnecting = false;

    const connect = () => {
      if (isConnecting || eventSourceRef.current?.readyState === EventSource.OPEN) {
        return;
      }

      isConnecting = true;
      console.log('[SSE] Connecting to event stream...');

      const eventSource = new EventSource('/api/events/stream');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('[SSE] Connected');
        setIsOnline(true);
        isConnecting = false;
        // Clear any pending reconnect
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onmessage = (event) => {
        try {
          // Skip keep-alive messages (they start with ":")
          if (event.data.startsWith(':')) {
            return;
          }

          const sseEvent: SSEEvent = JSON.parse(event.data);
          console.log('[SSE] Received event:', sseEvent.type);

          switch (sseEvent.type) {
            case 'task_created':
              addTask(sseEvent.payload as Task);
              break;

            case 'task_updated':
              updateTask(sseEvent.payload as Task);
              break;

            case 'activity_logged':
              // Activities are fetched when task detail is opened
              // We could optionally update a live feed here
              console.log('[SSE] Activity logged:', sseEvent.payload);
              break;

            case 'deliverable_added':
              // Deliverables are fetched when task detail is opened
              console.log('[SSE] Deliverable added:', sseEvent.payload);
              break;

            case 'agent_spawned':
              console.log('[SSE] Agent spawned:', sseEvent.payload);
              // Will trigger re-fetch of sub-agent count
              break;

            case 'agent_completed':
              console.log('[SSE] Agent completed:', sseEvent.payload);
              break;

            default:
              console.warn('[SSE] Unknown event type:', sseEvent);
          }
        } catch (error) {
          console.error('[SSE] Error parsing event:', error);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        setIsOnline(false);
        isConnecting = false;
        
        // Close the connection
        eventSource.close();
        eventSourceRef.current = null;

        // Attempt reconnection after 5 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('[SSE] Attempting to reconnect...');
          connect();
        }, 5000);
      };
    };

    // Initial connection
    connect();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        console.log('[SSE] Disconnecting...');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [addTask, updateTask, setIsOnline]);
}
