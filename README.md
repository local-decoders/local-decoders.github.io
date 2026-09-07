# Cellular Automata Decoder Visualizer

An interactive web-based visualization tool for quantum error correction decoders using cellular automata rules.

## Features

- **Multiple Decoder Types**: Visualize various quantum error correction codes including:
  - Toric Code (RGB coordinated and uncoordinated)
  - Surface Code
  - Repetition Code (periodic, open boundary, uncoordinated)
  - X-Cube Code (Lineon and Fracton sectors)
  - Haah Code

- **Interactive Controls**:
  - Adjustable system size
  - Error probability slider
  - Random or manual error placement
  - Step-by-step or animated simulation
  - Customizable display options

- **Modern Design**: Clean, responsive interface with intuitive controls and real-time visualization

## Running the Visualizer

### Option 1: Python HTTP Server

```bash
cd website
python3 serve.py
```

Then open your browser and navigate to `http://localhost:8000`

### Option 2: Using Python's built-in server

```bash
cd website
python3 -m http.server 8000
```

### Option 3: Using Node.js (if installed)

```bash
cd website
npx serve
```

## Usage

1. **Select a Decoder**: Choose from the dropdown menu to switch between different decoder types

2. **Configure Parameters**:
   - Set the system size (L)
   - Adjust error probability with the slider

3. **Initialize Errors**:
   - Click "Initialize" to add random errors
   - Select "Manual Placement" to click on the lattice and place errors

4. **Run Simulation**:
   - "Step" - Execute one CA step
   - "Play/Pause" - Run continuous animation
   - "Reset" - Clear all errors and restart

5. **Display Options**:
   - Toggle visibility of syndromes, errors, messages, and grid

## Architecture

- `index.html` - Main HTML structure
- `css/styles.css` - Modern styling and responsive design
- `js/main.js` - Core visualization engine and control logic
- `modules/` - Individual decoder implementations:
  - Each decoder module implements the CA rules
  - Provides `step()`, `render()`, and interaction methods

## Decoder Descriptions

### Toric Code (RGB)
Uses three message types (Red, Green, Blue) coordinated by a global clock to correct errors on a 2D torus.

### Surface Code
Similar to toric code but with boundary conditions, allowing logical operations for fault-tolerant quantum computation.

### Repetition Code
Simple 1D code that demonstrates basic error correction principles using majority voting.

### X-Cube Code
3D fracton code with mobile lineon excitations and immobile fracton excitations.

### Haah Code
3D fracton code with complex stabilizer structure and interesting topological properties.

## Customization

To add a new decoder:

1. Create a new module in `modules/`
2. Implement the required interface:
   - `constructor(L)` - Initialize with system size
   - `initializeRandomErrors(p)` - Add random errors
   - `step()` - Execute one CA step
   - `render(ctx, width, height, options)` - Draw visualization
   - `getSyndromeCount()` - Return active syndrome count
   - `getErrorCount()` - Return total error count

3. Register the decoder in `js/main.js` in the `decoderConfigs` object

## Browser Requirements

- Modern browser with ES6 module support
- Canvas API support
- Recommended: Chrome, Firefox, Safari (latest versions)

## License

This visualization tool is for educational and research purposes.