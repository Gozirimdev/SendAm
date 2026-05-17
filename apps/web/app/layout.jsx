import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import '@/styles/globals.css';

export const metadata = {
  title: 'SendAm | WhatsApp chain Payments',
  description: 'SendAm is a WhatsApp-based chain payment MVP.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="flex flex-col min-h-screen bg-gray-50 text-dark font-sans">
        <Navbar />
        <main className="flex-grow w-full min-w-0">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
