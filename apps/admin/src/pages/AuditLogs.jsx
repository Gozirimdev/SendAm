import { useEffect, useState } from 'react';
import { getAdminAuditLogs } from '@/lib/adminApi';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';

const DECODE_ACTION = 'sendam_ai.decode';

export default function AuditLogs() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');

  useEffect(() => {
    let cancelled = false;
    getAdminAuditLogs(action || undefined)
      .then((res) => {
        if (!cancelled) setRows(res.data || []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [action]);

  const columns = [
    { header: 'Actor', accessor: 'actorType' },
    { header: 'Action', accessor: 'action' },
    { header: 'Entity', render: (row) => row.entityType || '-' },
    { header: 'IP', render: (row) => row.ipAddress || '-' },
    { header: 'Created', render: (row) => new Date(row.createdAt).toLocaleString() },
    {
      header: 'Details',
      render: (row) =>
        row.metadata && Object.keys(row.metadata).length ? (
          <pre className="max-w-xl whitespace-pre-wrap break-words text-xs text-gray-600">
            {JSON.stringify(row.metadata, null, 2)}
          </pre>
        ) : (
          '-'
        ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <div className="flex items-center gap-2">
          <select
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">All actions</option>
            <option value={DECODE_ACTION}>sendam-ai decode requests</option>
          </select>
        </div>
      </div>
      {loading ? (
        <div className="flex justify-center py-20"><Loader size={32} /></div>
      ) : (
        <DataTable columns={columns} data={rows} keyField="_id" />
      )}
    </div>
  );
}
