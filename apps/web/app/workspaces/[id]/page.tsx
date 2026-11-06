import { WorkspaceView } from "../../../components/workspace-view";

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkspaceView workspaceId={id} />;
}
