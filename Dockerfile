# Use a small Node.js image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev && node -e "require('uuid'); require('@solana/web3.js'); console.log('deps ok')"

# Bundle app source
COPY public ./public
COPY server.js ./
COPY marketMonitor.js ./
COPY rewardsTimer.js ./

# Expose the port the app runs on
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
