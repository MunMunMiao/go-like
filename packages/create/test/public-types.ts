import { createProject, type CreatedProject } from "../src/index"

const created: Promise<CreatedProject> = createProject("catalog-service")

void created

// @ts-expect-error One target directory is required.
createProject()
// @ts-expect-error The target directory must be a string.
createProject(1)
