/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html','./src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {
    fontFamily: { sans: ['Inter','system-ui','sans-serif'] },
    colors: { ink: '#14201C', brand: {50:'#ECFDF5',100:'#D1FAE5',500:'#0E9F6E',600:'#0F766E',700:'#115E59'} }
  } },
  plugins: []
}
