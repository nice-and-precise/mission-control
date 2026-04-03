import { queryAll, queryOne, run } from '@/lib/db';
import { deleteTaskById } from '@/lib/tasks/delete-task';
import { hardDeleteWorkspace } from '@/lib/workspaces';
import type { Product, Task } from '@/lib/types';

export interface ProductDeleteResult {
  productId: string;
  workspaceId: string;
  deletedTaskCount: number;
  deletedWorkspace: boolean;
}

export function hardDeleteProduct(productId: string): ProductDeleteResult | null {
  const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) {
    return null;
  }

  const tasks = queryAll<Task>(
    'SELECT * FROM tasks WHERE product_id = ? ORDER BY created_at DESC',
    [productId]
  );

  for (const task of tasks) {
    deleteTaskById(task.id, {
      broadcastDeletion: false,
      drainWorkflowQueue: false,
      trashWorkspace: true,
    });
  }

  run('DELETE FROM workspace_ports WHERE product_id = ?', [productId]);
  run('DELETE FROM ideation_cycles WHERE product_id = ?', [productId]);
  run('DELETE FROM autopilot_activity_log WHERE product_id = ?', [productId]);
  run('DELETE FROM cost_events WHERE product_id = ?', [productId]);
  run('DELETE FROM cost_caps WHERE product_id = ?', [productId]);
  run('DELETE FROM products WHERE id = ?', [productId]);

  const deletedWorkspace =
    !!product.manages_workspace &&
    product.workspace_id !== 'default' &&
    hardDeleteWorkspace(product.workspace_id);

  return {
    productId,
    workspaceId: product.workspace_id,
    deletedTaskCount: tasks.length,
    deletedWorkspace,
  };
}
