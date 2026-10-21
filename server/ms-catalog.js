/* Microsoft service catalog for the posts-based parser.
   Microsoft publishes advisory posts, not a component API; services named in
   an active post are marked degraded. Aliases enable text matching
   (e.g. a post mentioning "Outlook" marks all Outlook clients). */
'use strict';

const M365 = 'Microsoft 365', AZ = 'Azure', PP = 'Power Platform', D365 = 'Dynamics 365',
  SEC = 'Security & Identity', DEV = 'Developer Tools', CON = 'Consumer';

const rows = [
  // Microsoft 365
  ['Microsoft 365 admin center', M365], ['Exchange Online', M365], ['Outlook on the web', M365, ['outlook']],
  ['Outlook desktop app', M365, ['outlook']], ['SharePoint Online', M365, ['sharepoint']],
  ['OneDrive for Business', M365, ['onedrive']], ['Microsoft Teams', M365, ['teams']],
  ['Microsoft 365 Apps for the web', M365], ['Microsoft 365 desktop apps', M365], ['Microsoft Word', M365],
  ['Microsoft Excel', M365], ['Microsoft PowerPoint', M365], ['Microsoft OneNote', M365],
  ['Microsoft Forms', M365], ['Microsoft Planner', M365], ['Microsoft To Do', M365],
  ['Microsoft Lists', M365], ['Microsoft Loop', M365], ['Microsoft Stream', M365],
  ['Microsoft Bookings', M365], ['Microsoft Sway', M365], ['Microsoft Whiteboard', M365],
  ['Microsoft Viva Engage', M365], ['Microsoft Viva Connections', M365], ['Microsoft Viva Insights', M365],
  ['Microsoft Viva Learning', M365], ['Microsoft Project', M365], ['Microsoft Visio', M365],
  ['Exchange Online Protection', M365], ['Exchange Online Archiving', M365], ['Microsoft 365 Copilot', M365, ['copilot']],
  ['Windows 365', M365, ['windows 365', 'cloud pc']],
  // Azure
  ['Azure Virtual Machines', AZ], ['Azure Virtual Machine Scale Sets', AZ], ['Azure App Service', AZ],
  ['Azure Functions', AZ], ['Azure Batch', AZ], ['Azure Container Apps', AZ], ['Azure Container Instances', AZ],
  ['Azure Kubernetes Service', AZ], ['Azure Container Registry', AZ], ['Azure SQL Database', AZ],
  ['Azure Cosmos DB', AZ], ['Azure Database for PostgreSQL', AZ], ['Azure Database for MySQL', AZ],
  ['Azure Managed Redis', AZ], ['Azure Storage', AZ], ['Azure Blob Storage', AZ], ['Azure Files', AZ],
  ['Azure Managed Disks', AZ], ['Azure Virtual Network', AZ], ['Azure Load Balancer', AZ],
  ['Azure Application Gateway', AZ], ['Azure Front Door', AZ], ['Azure Traffic Manager', AZ],
  ['Azure DNS', AZ], ['Azure VPN Gateway', AZ], ['Azure ExpressRoute', AZ], ['Azure API Management', AZ],
  ['Azure Service Bus', AZ], ['Azure Event Grid', AZ], ['Azure Event Hubs', AZ], ['Azure Logic Apps', AZ],
  ['Azure OpenAI Service', AZ], ['Azure Machine Learning', AZ], ['Azure AI Search', AZ],
  ['Azure AI Document Intelligence', AZ], ['Microsoft Fabric', AZ], ['Azure Synapse Analytics', AZ],
  ['Azure Data Factory', AZ], ['Azure Databricks', AZ], ['Azure IoT Hub', AZ], ['Azure IoT Central', AZ],
  ['Azure Monitor', AZ], ['Azure Log Analytics', AZ], ['Application Insights', AZ], ['Azure Backup', AZ],
  ['Azure Site Recovery', AZ], ['Azure Service Health', AZ], ['Azure Arc', AZ], ['Azure Key Vault', AZ],
  // Power Platform
  ['Power Platform admin center', PP], ['Power Apps', PP], ['Power Automate', PP], ['Power Pages', PP],
  ['Power BI', PP], ['Microsoft Dataverse', PP], ['Microsoft Copilot Studio', PP, ['copilot']],
  // Dynamics 365
  ['Dynamics 365 Sales', D365], ['Dynamics 365 Customer Service', D365], ['Dynamics 365 Field Service', D365],
  ['Dynamics 365 Finance', D365], ['Dynamics 365 Supply Chain Management', D365],
  ['Dynamics 365 Business Central', D365], ['Dynamics 365 Customer Insights', D365],
  ['Dynamics 365 Project Operations', D365], ['Dynamics 365 Commerce', D365], ['Dynamics 365 Human Resources', D365],
  // Security & Identity
  ['Microsoft Entra ID', SEC, ['entra']], ['Microsoft Entra External ID', SEC, ['entra']],
  ['Microsoft Intune', SEC, ['intune']], ['Microsoft Defender for Endpoint', SEC, ['defender']],
  ['Microsoft Defender for Identity', SEC, ['defender']], ['Microsoft Defender for Cloud Apps', SEC, ['defender']],
  ['Microsoft Defender for Cloud', SEC, ['defender']], ['Microsoft Sentinel', SEC, ['sentinel']],
  ['Microsoft Purview', SEC, ['purview']],
  // Developer Tools
  ['Azure DevOps', DEV, ['devops']], ['Azure Boards', DEV], ['Azure Pipelines', DEV], ['Azure Repos', DEV],
  ['Azure Artifacts', DEV], ['Visual Studio services', DEV], ['Microsoft Graph', DEV, ['graph']],
  // Consumer
  ['Microsoft 365 (Consumer)', CON], ['Microsoft Copilot', CON, ['copilot']], ['Microsoft Teams Free', CON, ['teams']],
  ['Microsoft To-Do', CON], ['Office for the web (Consumer)', CON], ['OneDrive', CON, ['onedrive']],
  ['Outlook.com', CON, ['outlook']], ['Phone Link', CON], ['Universal Print', M365]
];

module.exports = rows.map(([name, group, aliases]) => ({
  name,
  group,
  aliases: (aliases || []).map(a => a.toLowerCase())
}));
