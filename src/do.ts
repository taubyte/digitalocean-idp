import { createApiClient } from "dots-wrapper";

import dotenv from "dotenv";
dotenv.config();

const myApiToken = process.env.DIGITALOCEAN_API_TOKEN || "";
const myProjectName = process.env.DIGITALOCEAN_PROJECT_NAME || "spore drive test";

const dots = createApiClient({ token: myApiToken });

const findProjectByName = async (projectName: string) => {
  const {
    data: { projects },
  } = await dots.project.listProjects({});

  const project = projects.find(
    (proj: { name: string }) => proj.name === projectName
  );

  if (project) {
    return project;
  } else {
    throw new Error(`Project with name "${projectName}" not found.`);
  }
};

const listDropletsByProjectId = async (projectId: string) => {
  const {
    data: { resources },
  } = await dots.project.listProjectResources({ project_id: projectId });

  const droplets = resources.filter((resource: { urn: string }) =>
    resource.urn.startsWith("do:droplet:")
  );

  return droplets;
};

const getDropletByUrn = async (dropletUrn: string) => {
  const dropletId = parseInt(dropletUrn.split(":").pop() || "");

  if (isNaN(dropletId)) {
    throw new Error("Invalid droplet ID in URN");
  }

  const { data: droplet } = await dots.droplet.getDroplet({
    droplet_id: dropletId,
  });
  return droplet.droplet;
};

export const Droplets = async () => {
  const droplets = await listDropletsByProjectId(
    (
      await findProjectByName(myProjectName)
    ).id
  );

  const list = [];
  for (const res of droplets) {
    const droplet = await getDropletByUrn(res.urn);
    list.push(droplet);
  }

  return list;
};

export const DropletInfo = (droplet: any) => {
  const hostname = droplet.name;
  const publicIp = droplet.networks.v4.find(
    (network: { type: string }) => network.type === "public"
  )?.ip_address;

  const tags = droplet.tags;

  return {
    hostname,
    publicIp,
    tags,
  };
};
