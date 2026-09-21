export default function App() {
  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold">NexaAI</h1>

        <p className="mt-2 text-gray-600">
          Enterprise AI Knowledge & Automation Platform
        </p>

        <div className="mt-8 grid gap-6 md:grid-cols-3">
          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="font-semibold">Documents</h2>
            <p className="mt-2 text-3xl font-bold">0</p>
          </div>

          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="font-semibold">AI Queries</h2>
            <p className="mt-2 text-3xl font-bold">0</p>
          </div>

          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="font-semibold">Organizations</h2>
            <p className="mt-2 text-3xl font-bold">0</p>
          </div>
        </div>
      </div>
    </main>
  );
}