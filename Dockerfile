# Use a small Node.js image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY public ./public
COPY server.js ./
COPY marketMonitor.js ./
COPY rewardsTimer.js ./

# Expose the port the app runs on
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
