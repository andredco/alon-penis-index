# JewDick - Market Cap Character App

A Node.js web application that displays a 3D character that scales in size based on cryptocurrency token market cap data in real-time.

## Features

- 🎮 **3D Character Display**: Loads and renders your custom .fbx character model
- 📈 **Market Cap Integration**: Connects to cryptocurrency APIs to fetch real-time market cap data
- 🔄 **Real-time Updates**: WebSocket connection for live market cap updates every 10 seconds
- 📱 **Responsive Design**: Works on desktop and mobile devices
- 🎨 **Procedural Enhancement**: Automatically adds missing anatomy to the character
- 📊 **Scaling Animation**: Smooth scaling animations based on market cap changes

## Setup

### Prerequisites
- Node.js (v14 or higher)
- npm

### Installation

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the server:**
   ```bash
   npm start
   ```
   
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

3. **Open your browser:**
   Navigate to `http://localhost:3000`

## How it Works

### Market Cap Scaling
- The character scales logarithmically based on market cap
- Base market cap: $100M (scale factor 1.0x)
- Scale range: 0.5x - 5.0x
- Updates every 10 seconds via WebSocket

### API Integration
- Default: Uses Bitcoin market cap from CoinGecko API
- Custom token: Replace the token ID in `server.js`
- Endpoint: `/api/marketcap/:tokenAddress`

### Character Features
- Loads the `Wealthy_Traveler_0715225309_texture.fbx` model
- Adds procedurally generated anatomy
- Smooth scaling animations
- Idle bobbing animation
- Interactive camera controls (click and drag to rotate, scroll to zoom)

## Customization

### Using Your Own Token
1. Get your token's CoinGecko ID
2. Update the `tokenAddress` in `server.js` line 47
3. Or use the API endpoint: `/api/marketcap/your-token-id`

### Different Character Model
1. Replace the .fbx file in the `public/` directory
2. Update the filename in `public/index.html` line 112

### Scaling Logic
Modify the scaling calculation in `updateMarketCap()` function:
```javascript
const scaleFactor = Math.log(marketCap / baseMarketCap) / Math.log(10);
this.targetScale = Math.max(0.5, Math.min(5.0, 1 + scaleFactor * 0.5));
```

## Controls
- **Mouse**: Click and drag to rotate camera
- **Scroll**: Zoom in/out
- **Real-time**: Character automatically scales with market cap changes

## Technical Stack
- **Backend**: Node.js, Express, WebSocket
- **Frontend**: Three.js, HTML5, CSS3
- **3D**: FBX loader, procedural geometry
- **API**: CoinGecko cryptocurrency data

## Development Notes

The application creates a 3D scene with:
- Your character model loaded from the .fbx file
- Procedurally generated anatomy attached to the character
- Real-time market cap data fetching
- Smooth scaling animations
- Camera controls for interaction

The character scale is calculated logarithmically to provide meaningful visual feedback across different market cap ranges. 