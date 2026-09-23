import './ui/style.css';
import { App } from './app/App';

const canvas = document.getElementById('universe') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const app = new App(canvas, ui);
app.start();
