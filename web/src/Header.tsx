import { Link } from 'react-router';
import { Logo } from './icons.tsx';

export function Header() {
  return (
    <header className="header">
      <div className="header-content">
        <Link to="/" className="brand">
          <Logo size={36} />
          <span>sprint <b>pointing</b></span>
        </Link>
      </div>
    </header>
  );
}
