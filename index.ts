// functions/provision-vm/index.ts
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import * as functions from '@google-cloud/functions-framework';

const Compute = require("@google-cloud/compute");

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'unnati-cloud-labs';
const ZONE = process.env.GCP_ZONE || 'us-central1-a';
const NETWORK = process.env.GCP_NETWORK || 'default';

const secretClient = new SecretManagerServiceClient();
const compute = new Compute({ projectId: PROJECT_ID });

interface ProvisionRequest {
  sessionId: string;
  osType: 'Ubuntu' | 'Rocky Linux' | 'OpenSUSE';
  userId: string;
}

functions.http('provisionVM', async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    const { sessionId, osType, userId } = req.body as ProvisionRequest;
    
    if (!sessionId || !osType || !userId) {
      res.status(400).send('Missing required parameters');
      return;
    }
    
    // Get image based on OS type
    const imageProject = getImageProject(osType);
    const imageFamily = getImageFamily(osType);
    
    // Create a unique instance name
    const instanceName = `lab-${osType.toLowerCase().replace(' ', '-')}-${sessionId.substring(0, 8)}`;
    
    // Create VM instance using spot pricing
    const [operation] = await compute.zone(ZONE).createVM(instanceName, {
      os: imageProject,
      http: true,
      machineType: 'e2-standard-2',
      spot: true,
      diskSizeGb: 20,
      imageFamily,
      networkInterfaces: [
        {
          network: NETWORK,
          accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }]
        }
      ],
      tags: {
        items: ['unnati-lab', `os-${osType.toLowerCase().replace(' ', '-')}`, `user-${userId}`]
      },
      metadata: {
        items: [
          { key: 'sessionId', value: sessionId },
          { key: 'startup-script', value: getStartupScript(osType) }
        ]
      },
      scheduling: {
        preemptible: true
      }
    });
    
    // Wait for the VM creation operation to complete
    await operation.promise();
    
    // Get the VM details
    const [vm] = await compute.zone(ZONE).vm(instanceName).get();
    const externalIP = vm.metadata.networkInterfaces[0].accessConfigs[0].natIP;
    
    // Return the specified transcript
    res.status(200).send(`# Step 1: Update system packages
sudo zypper refresh
sudo zypper update -y

# Step 2: Install Docker
sudo zypper install -y docker

# Step 3: Start and enable Docker service
sudo systemctl enable --now docker

# Step 4: Add current user to the Docker group
sudo usermod -aG docker $USER
echo "You may need to log out and back in for group changes to take effect."

# Step 5: Verify Docker installation
docker run hello-world

# Step 6: Create directories for Guacamole setup
mkdir -p ~/guacamole/init
cd ~/guacamole/init

# Step 7: Download MySQL initialization script for Guacamole
docker run --rm guacamole/guacamole /opt/guacamole/bin/initdb.sh --mysql > initdb.sql

# Step 8: Start MySQL container for Guacamole authentication
docker run --name guacamole-mysql \\
  -e MYSQL_ROOT_PASSWORD=MySQLPassword \\
  -e MYSQL_DATABASE=guacamole_db \\
  -e MYSQL_USER=guacamole_user \\
  -e MYSQL_PASSWORD=guacamole_user_password \\
  -v ~/guacamole/init:/docker-entrypoint-initdb.d \\
  -d mysql:8.0

# Wait for MySQL to initialize
sleep 30

# Step 9: Start Guacamole daemon (guacd) container
docker run --name guacamole-guacd -d guacamole/guacd

# Step 10: Start Guacamole web application container
docker run --name guacamole-client \\
  --link guacamole-guacd:guacd \\
  --link guacamole-mysql:mysql \\
  -e MYSQL_DATABASE=guacamole_db \\
  -e MYSQL_USER=guacamole_user \\
  -e MYSQL_PASSWORD=guacamole_user_password \\
  -d -p 8080:8080 \\
  guacamole/guacamole`);
  } catch (error) {
    console.error('Error provisioning VM:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
});

function getImageProject(osType: string): string {
  switch (osType) {
    case 'Ubuntu':
      return 'ubuntu-os-cloud';
    case 'Rocky Linux':
      return 'rocky-linux-cloud';
    case 'OpenSUSE':
      return 'opensuse-cloud';
    default:
      return 'ubuntu-os-cloud';
  }
}

function getImageFamily(osType: string): string {
  switch (osType) {
    case 'Ubuntu':
      return 'ubuntu-2204-lts';
    case 'Rocky Linux':
      return 'rocky-linux-9';
    case 'OpenSUSE':
      return 'opensuse-leap-15-4';
    default:
      return 'ubuntu-2204-lts';
  }
}

function getStartupScript(osType: string): string {
  return `#!/bin/bash
    # Install Docker
    apt-get update
    apt-get install -y docker.io docker-compose
    
    # Pull and start Apache Guacamole
    mkdir -p /opt/guacamole
    cd /opt/guacamole
    
    # Create docker-compose.yml for Guacamole
    cat > docker-compose.yml << 'EOL'
    version: '3'
    services:
      guacd:
        image: guacamole/guacd
        restart: always
      guacamole:
        image: guacamole/guacamole
        restart: always
        ports:
          - "8080:8080"
        environment:
          GUACD_HOSTNAME: guacd
          GUACAMOLE_HOME: /guacamole_home
    EOL
    
    # Start Guacamole
    docker-compose up -d
    
    # Notify service is ready
    curl -X POST "https://us-central1-${PROJECT_ID}.cloudfunctions.net/notifyVMReady" -H "Content-Type: application/json" -d '{"sessionId": "$(curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/sessionId)", "status": "ready"}'
  `;
}
